// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Factory} from "../src/Factory.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {TokenParams, Socials} from "../src/Types.sol";
import {Token} from "../src/Token.sol";
import {ILaunchDeployer} from "../src/interfaces/ILaunchDeployer.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/// @notice The first launch: TICKR, priced in FUN. Runs as the last step of a deployment, while launches are
/// still closed to everyone but the deployer, so nothing can be put in front of it. Then it opens launches.
///
/// What it does, in order: create FUN (a one-for-one wrapper of USDG) and launch TICKR under it in one call,
/// exactly as any creator would; buy the disclosed first slice through the zap, paid in ETH, so the amount is a
/// matter of public record; open launches to everyone. It refuses to run if FUN already exists.
///
/// env: PRIVATE_KEY (the deployer, whitelisted at deploy), TREASURY (holds the genesis TICKR and is its fee recipient, defaults to the deployer),
/// GENESIS_LOGO (image URI, may be empty), GENESIS_SHARE_BPS (first buy as a share of supply, default 680 = 6.8%).
///
/// TICKR's address ends in 6942, like every coin launched from the site. The salt is ground here, off chain, against
/// the deployed LaunchDeployer's own prediction, and the script refuses to launch if the prediction does not end that way.
contract Genesis is Script {
    using stdJson for string;

    uint256 internal constant FEE_ETH_USDG = 100;
    uint16 internal constant VANITY_SUFFIX = 0x6942;
    int24 internal constant TICK_ETH_USDG = 1;

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        string memory j = vm.readFile(path);
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", me);
        uint256 shareBps = vm.envOr("GENESIS_SHARE_BPS", uint256(680));
        Factory factory = Factory(payable(j.readAddress(".factory")));
        TickerLauncher tickers = TickerLauncher(j.readAddress(".tickerLauncher"));
        ZapRouter zap = ZapRouter(payable(j.readAddress(".zapRouter")));
        address usdg = j.readAddress(".usdg");

        require(factory.canLaunch(me), "genesis: deployer cannot launch");
        require(!factory.launchEnabled(), "genesis: launches are already open; genesis must come first");
        require(tickers.tickerFor("FUN") == address(0), "genesis: FUN already exists");

        vm.startBroadcast(pk);

        // 1. TICKR priced in FUN, through the same call every creator uses
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        TokenParams memory p = TokenParams({
            name: "tickr",
            symbol: "TICKR",
            logo: vm.envOr("GENESIS_LOGO", string("")),
            description: "the coin of tickr. priced in FUN, a one-for-one wrapper of USDG. the first launch on the platform, on the same rules as every launch.",
            socials: Socials("https://x.com/tickrdotfun_rh", "", "", "https://tickrfun.gg", ""),
            creatorFeeRecipient: treasury,
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: expected,
            salt: bytes32(0)
        });
        {
            ILaunchDeployer deployer = ILaunchDeployer(j.readAddress(".launchDeployer"));
            uint256 supplyOf = factory.getLaunchConfig(0).supply;
            // the seed is secret until this transaction lands, so nobody can compute TICKR's address and squat its pool
            bytes32 seed = vm.envBytes32("GENESIS_SEED");
            require(seed != bytes32(0), "genesis: set GENESIS_SEED to a random bytes32");
            p.salt = _grindSalt(deployer, me, p, supplyOf, seed);
            address predicted = deployer.predictToken(me, p, supplyOf);
            require(uint16(uint160(predicted)) == VANITY_SUFFIX, "genesis: predicted TICKR address does not end in 6942");
            console.log("  genesis TICKR predicted", predicted);
        }
        // inventing FUN costs the ticker fee on top of the launch fee: it opens FUN's guarded dollar pool, locked
        (address fun, address tickr, bytes32 poolId) = tickers.launch{value: factory.launchFee() + tickers.NEW_TICKER_FEE()}("FUN", p, 0);
        console.log("  genesis FUN   ", fun);
        console.log("  genesis TICKR ", tickr);
        console.log("  genesis pool  ", vm.toString(poolId));

        // 2. the disclosed first buy, paid in ETH through the zap: ETH -> USDG -> FUN -> the pool
        uint256 supply = IERC20(tickr).totalSupply();
        uint256 target = (supply * shareBps) / 10_000;
        ZapRouter.Hop[] memory route = new ZapRouter.Hop[](3);
        route[0] = ZapRouter.Hop({
            kind: zap.HOP_V4(),
            key: PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(usdg), fee: uint24(FEE_ETH_USDG), tickSpacing: TICK_ETH_USDG, hooks: IHooks(address(0))}),
            pool: address(0)
        });
        route[1] = ZapRouter.Hop({kind: zap.HOP_WRAP(), key: route[0].key, pool: fun});
        // the coin's own pool is the last hop
        route[2] = ZapRouter.Hop({kind: zap.HOP_V4(), key: factory.poolKeyOf(tickr), pool: address(0)});
        // the price probes revert by design, so they must not be queued as transactions: quote outside the
        // broadcast window, against the launch that was just simulated, then resume broadcasting the real buy
        vm.stopBroadcast();
        uint256 value = _ethFor(zap, tickr, route, target, me);
        vm.startBroadcast(pk);
        uint256 got = zap.zapBuy{value: value}(
            ZapRouter.ZapParams({token: tickr, tokenIn: address(0), amountIn: 0, path: route, minTokensOut: (target * 97) / 100, recipient: treasury, deadline: block.timestamp + 600})
        );
        console.log("  genesis first buy: TICKR", got / 1e18, "for wei", value);
        console.log("  genesis first buy share bps", (got * 10_000) / supply);

        // 3. open launches to everyone, and take the deployer's own pass away: from here it is a wallet like any other
        factory.setLaunchEnabled(true);
        factory.setWhitelistedLauncher(me, false);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(tickr), path, ".genesisToken");
        vm.writeJson(vm.toString(fun), path, ".genesisTicker");
        vm.writeJson(vm.toString(poolId), path, ".genesisPool");
        console.log("  genesis launches open; recorded in", path);
    }

    /// @dev Binary search for the ETH that buys `target` coins, quoted through `previewZap`'s revert.
    function _ethFor(ZapRouter zap, address token, ZapRouter.Hop[] memory route, uint256 target, address me)
        internal
        returns (uint256)
    {
        uint256 lo = 0.0005 ether;
        uint256 hi = 2 ether;
        for (uint256 i; i < 18; i++) {
            uint256 mid = (lo + hi) / 2;
            uint256 out = _quote(zap, token, route, mid, me);
            if (out < target) lo = mid;
            else hi = mid;
        }
        return hi;
    }

    function _quote(ZapRouter zap, address token, ZapRouter.Hop[] memory route, uint256 value, address me)
        internal
        returns (uint256 tokensOut)
    {
        // a throwaway address sends the probe in the local simulation. It must not be the broadcaster, or forge
        // counts every probe against the broadcaster's nonce and then waits for a nonce that never comes.
        address prober = address(uint160(uint256(keccak256("tickr genesis probe"))));
        vm.deal(prober, 100 ether);
        vm.prank(prober);
        try zap.previewZap{value: value}(
            ZapRouter.ZapParams({token: token, tokenIn: address(0), amountIn: 0, path: route, minTokensOut: 0, recipient: me, deadline: block.timestamp + 600})
        ) {
            revert("genesis: preview did not revert");
        } catch (bytes memory r) {
            require(r.length >= 68, "genesis: no quote");
            uint256 a;
            uint256 b;
            assembly {
                a := mload(add(r, 36))
                b := mload(add(r, 68))
            }
            (a);
            tokensOut = b;
        }
    }

    /// Mirrors LaunchDeployer: the coin lands at CREATE2(deployer, keccak256(initiator ++ salt), initCodeHash). Tries
    /// salts derived from a fixed seed until the address ends in 6942, so the result is reproducible from the inputs.
    /// The loop works in a fixed scratch area of memory: hundreds of thousands of tries must not grow memory, or the
    /// script runs out of it.
    function _grindSalt(ILaunchDeployer deployer, address initiator, TokenParams memory p, uint256 supply, bytes32 seed) internal view returns (bytes32 found) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(Token).creationCode,
                abi.encode(p.name, p.symbol, p.logo, p.description, p.socials, supply, address(factoryOf(deployer)))
            )
        );
        uint256 tries;
        assembly ("memory-safe") {
            let buf := mload(0x40)
            mstore(0x40, add(buf, 0x100)) // reserve 256 bytes once; every try reuses them
            // layout: [0..64) seed ++ i | [64..116) initiator ++ userSalt | [128..213) 0xff ++ deployer ++ salt ++ initCodeHash
            mstore(buf, seed)
            mstore(add(buf, 64), shl(96, initiator))
            mstore8(add(buf, 128), 0xff)
            mstore(add(buf, 129), shl(96, deployer))
            mstore(add(buf, 181), initCodeHash)
            for { let i := 0 } lt(i, 4000000) { i := add(i, 1) } {
                mstore(add(buf, 32), i)
                let userSalt := keccak256(buf, 64)
                mstore(add(buf, 84), userSalt)
                let salt := keccak256(add(buf, 64), 52)
                mstore(add(buf, 149), salt)
                let a := and(keccak256(add(buf, 128), 85), 0xffffffffffffffffffffffffffffffffffffffff)
                if eq(and(a, 0xffff), 0x6942) {
                    found := userSalt
                    tries := add(i, 1)
                    break
                }
            }
        }
        require(found != bytes32(0), "genesis: no salt found");
        console.log("  genesis salt found after tries", tries);
    }

    function factoryOf(ILaunchDeployer deployer) internal view returns (address) {
        return deployer.factory();
    }
}
