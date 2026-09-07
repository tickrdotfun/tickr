// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {GenesisSizer} from "./lib/GenesisSizer.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Factory} from "../src/Factory.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {TokenParams, Socials} from "../src/Types.sol";
import {Token} from "../src/Token.sol";
import {ILaunchDeployer} from "../src/interfaces/ILaunchDeployer.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/// @notice The first launch: TICKR, priced in FUN. Runs as the last step of a deployment, while launches are
/// still closed to everyone but the deployer, so nothing can be put in front of it. Then it opens launches.
///
/// What it does, in order: turn the ETH for the first buy into USDG; create FUN (a one-for-one wrapper of USDG),
/// launch TICKR under it and make the disclosed first buy, all in one transaction through the same call any
/// creator can use, so nobody can trade the pool before the treasury holds its slice; hand the slice to the
/// treasury; open launches to everyone. It refuses to run if FUN already exists.
///
/// The buy is sized by the chain itself: before anything is sent, the script swaps, launches and buys in a
/// simulation it throws away, and searches for the ETH that buys the disclosed share. The pool is new both
/// times, so the dollars found there buy the same coins on the chain.
///
/// env: PRIVATE_KEY (the deployer, whitelisted at deploy), TREASURY (holds the genesis TICKR and is its fee recipient, defaults to the deployer),
/// GENESIS_LOGO (image URI, may be empty), GENESIS_SHARE_BPS (first buy as a share of supply, default 500 = 5%).
///
/// This file holds one contract and must stay that way: with two, `forge script script/Genesis.s.sol` refuses to
/// run without `--tc`, and neither local.sh nor the runbook passes it. Helpers live in script/lib.
///
/// TICKR's address ends in 6942, like every coin launched from the site, and sorts below FUN's, like every coin under
/// a name. The salt is ground here, off chain, against the deployed LaunchDeployer's own prediction, and the script
/// refuses to launch if the prediction does not come out that way.
///
/// After the launch come the two activation buys, each its own transaction: FUN itself, bought through its own pool
/// and paid to the deployer's wallet, then TICKR. Chart sites price a name from a swap that lands in a wallet after
/// the pool exists, and price the coin from a buy after its pool exists; the launch transaction is neither.
/// env: GENESIS_ACTIVATION_ETH (ETH for each of the two buys, default 0.005).
contract Genesis is Script {
    using stdJson for string;

    uint24 internal constant FEE_ETH_USDG = 100;
    uint16 internal constant VANITY_SUFFIX = 0x6942;
    int24 internal constant TICK_ETH_USDG = 1;
    /// @dev The real swap takes this much more ETH than the simulated one, so a move in the ETH/USDG pool between
    /// the two cannot leave the buy short of dollars. Dollars not needed stay in the deployer.
    uint256 internal constant SWAP_MARGIN_BPS = 500;

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        string memory j = vm.readFile(path);
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", me);
        uint256 shareBps = vm.envOr("GENESIS_SHARE_BPS", uint256(500));
        Factory factory = Factory(payable(j.readAddress(".factory")));
        TickerLauncher tickers = TickerLauncher(j.readAddress(".tickerLauncher"));
        LaunchSeeder seeder = LaunchSeeder(payable(j.readAddress(".launchSeeder")));
        ZapRouter zap = ZapRouter(payable(j.readAddress(".zapRouter")));
        address usdg = j.readAddress(".usdg");
        uint256 activationEth = vm.envOr("GENESIS_ACTIVATION_ETH", uint256(0.005 ether));

        require(factory.canLaunch(me), "genesis: deployer cannot launch");
        require(!factory.launchEnabled(), "genesis: launches are already open; genesis must come first");
        require(tickers.tickerFor("FUN") == address(0), "genesis: FUN already exists");

        // 1. TICKR priced in FUN, through the same call every creator uses
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        TokenParams memory p = TokenParams({
            name: "tickr",
            symbol: "TICKR",
            logo: vm.envOr("GENESIS_LOGO", string("")),
            description: "the coin of tickr. priced in FUN, a one-for-one wrapper of USDG. the first launch on the platform, on the same rules as every launch.",
            socials: Socials("https://x.com/tickrdotfun_rh", "", "", "https://tickrfun.gg", ""),
            creatorFeeRecipient: treasury,
            creatorTaxBps: 200, // 2% on every trade, all of it to the treasury wallet, shown like any creator tax
            buybackEnabled: false,
            expectedEconomics: expected,
            salt: bytes32(0)
        });
        uint256 supplyOf = factory.getLaunchConfig(0).supply;
        {
            ILaunchDeployer deployer = ILaunchDeployer(j.readAddress(".launchDeployer"));
            // the seed is secret until this transaction lands, so nobody can compute TICKR's address and squat its pool
            bytes32 seed = vm.envBytes32("GENESIS_SEED");
            require(seed != bytes32(0), "genesis: set GENESIS_SEED to a random bytes32");
            address funPredicted = tickers.predictTicker("FUN");
            p.salt = _grindSalt(deployer, me, p, supplyOf, seed, funPredicted);
            address predicted = deployer.predictToken(me, p, supplyOf);
            require(uint16(uint160(predicted)) == VANITY_SUFFIX, "genesis: predicted TICKR address does not end in 6942");
            require(predicted < funPredicted, "genesis: TICKR must sort below FUN");
            console.log("  genesis FUN predicted  ", funPredicted);
            console.log("  genesis TICKR predicted", predicted);
        }

        // 2. the disclosed first buy, sized in a simulation of the very transaction that makes it
        uint256 target = (supplyOf * shareBps) / 10_000;
        // inventing FUN costs the ticker fee on top of the launch fee: it becomes the first dollars of FUN's own pool
        uint256 fees = factory.launchFee() + tickers.NEW_TICKER_FEE();
        PoolKey memory ethUsdg = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(usdg), fee: FEE_ETH_USDG, tickSpacing: TICK_ETH_USDG, hooks: IHooks(address(0))});
        (uint256 ethIn, uint256 usdgIn, uint256 coinsOut) = _sizeFirstBuy(seeder, tickers, usdg, ethUsdg, p, fees, target, me);
        require(coinsOut >= (target * 99) / 100, "genesis: the first buy cannot reach the share");
        console.log("  genesis first buy sized: wei", ethIn, "usdg", usdgIn);

        vm.startBroadcast(pk);

        // 3. the dollars, from the ETH/USDG pool, with a margin for the pool moving before this lands; the swap
        //    refuses to land short of what the buy needs, so nothing is launched without its first buy
        uint256 ethSwap = (ethIn * (10_000 + SWAP_MARGIN_BPS)) / 10_000;
        seeder.swapExactIn{value: ethSwap}(ethUsdg, true, ethSwap, usdgIn, me);
        IERC20(usdg).approve(address(tickers), usdgIn);

        // 4. FUN invented, TICKR launched under it, and the first buy, in one transaction: nothing can trade the pool first
        (address fun, address tickr, bytes32 poolId, uint256 got) = tickers.launchAndBuy{value: fees}("FUN", p, 0, usdgIn, (target * 99) / 100);
        console.log("  genesis FUN   ", fun);
        console.log("  genesis TICKR ", tickr);
        console.log("  genesis pool  ", vm.toString(poolId));
        console.log("  genesis first buy: TICKR", got / 1e18, "for usdg", usdgIn);
        console.log("  genesis first buy share bps", (got * 10_000) / supplyOf);

        // 5. exactly the disclosed share to the treasury; the crumbs the search overshot by stay with the deployer
        if (treasury != me) IERC20(tickr).transfer(treasury, got < target ? got : target);

        // 6. the two activation buys, one transaction each, both to the deployer's own wallet: FUN through its own
        //    pool first, then TICKR through FUN's pool and its own. from here chart sites can price both
        _activate(zap, factory, ethUsdg, fun, tickr, activationEth, me);

        // 7. open launches to everyone, and take the deployer's own pass away: from here it is a wallet like any other
        factory.setLaunchEnabled(true);
        factory.setWhitelistedLauncher(me, false);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(tickr), path, ".genesisToken");
        vm.writeJson(vm.toString(fun), path, ".genesisTicker");
        vm.writeJson(vm.toString(poolId), path, ".genesisPool");
        console.log("  genesis launches open; recorded in", path);
    }

    /// @dev The two activation buys, as the site sends them for every launch under a name: the name into the wallet
    /// through its own pool, then the coin through the name's pool and its own. Two transactions under a broadcast.
    function _activate(ZapRouter zap, Factory factory, PoolKey memory ethUsdg, address fun, address tickr, uint256 eth, address me) internal {
        ZapRouter.Hop[] memory toFun = new ZapRouter.Hop[](2);
        toFun[0] = ZapRouter.Hop({kind: 0, key: ethUsdg, pool: address(0)});
        toFun[1] = ZapRouter.Hop({kind: 0, key: ManagedTickerToken(fun).poolKey(), pool: address(0)});
        uint256 funGot = zap.zapTicker{value: eth}(ZapRouter.ZapTickerParams({ticker: fun, tokenIn: address(0), amountIn: 0, path: toFun, minOut: 0, recipient: me, deadline: block.timestamp + 30 minutes}));
        console.log("  genesis activation 1: FUN to the wallet", funGot);
        ZapRouter.Hop[] memory toTickr = new ZapRouter.Hop[](3);
        toTickr[0] = toFun[0];
        toTickr[1] = toFun[1];
        toTickr[2] = ZapRouter.Hop({kind: 0, key: factory.poolKeyOf(tickr), pool: address(0)});
        uint256 tickrGot = zap.zapBuy{value: eth}(ZapRouter.ZapParams({token: tickr, tokenIn: address(0), amountIn: 0, path: toTickr, minTokensOut: 0, recipient: me, deadline: block.timestamp + 30 minutes}));
        console.log("  genesis activation 2: TICKR to the wallet", tickrGot);
    }

    /// @dev Finds the ETH whose dollars buy `target` coins, by doing the whole thing in a simulation that is thrown
    /// away: swap, launch and buy exactly as the real transactions will, then compare. Twenty halvings between half
    /// a thousandth and two ETH pin the amount to a millionth. A probe the dollar pool cannot absorb counts as too
    /// much. Every attempt is reverted, the deployer's balance and nonce included, so nothing here is broadcast.
    function _sizeFirstBuy(
        LaunchSeeder seeder,
        TickerLauncher tickers,
        address usdg,
        PoolKey memory ethUsdg,
        TokenParams memory p,
        uint256 fees,
        uint256 target,
        address me
    ) internal returns (uint256 ethIn, uint256 usdgIn, uint256 coinsOut) {
        GenesisSizer sizer = new GenesisSizer();
        uint256 snap = vm.snapshotState();
        vm.deal(me, address(me).balance + 20 ether);
        uint256 lo = 0.0005 ether;
        uint256 hi = 2 ether;
        for (uint256 i; i < 20; i++) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,, uint256 out) = _tryFirstBuy(sizer, seeder, tickers, usdg, ethUsdg, p, fees, mid, me);
            if (ok && out < target) lo = mid;
            else hi = mid;
        }
        ethIn = hi;
        bool fine;
        (fine, usdgIn, coinsOut) = _tryFirstBuy(sizer, seeder, tickers, usdg, ethUsdg, p, fees, ethIn, me);
        vm.revertToState(snap);
        require(fine, "genesis: the dollar pool cannot fill the first buy");
    }

    /// @dev One attempt, reverted afterwards whether it worked or not.
    function _tryFirstBuy(
        GenesisSizer sizer,
        LaunchSeeder seeder,
        TickerLauncher tickers,
        address usdg,
        PoolKey memory ethUsdg,
        TokenParams memory p,
        uint256 fees,
        uint256 eth,
        address me
    ) internal returns (bool ok, uint256 usdgGot, uint256 out) {
        uint256 s = vm.snapshotState();
        try sizer.attempt(seeder, tickers, usdg, ethUsdg, p, fees, eth, me) returns (uint256 got, uint256 coins) {
            (ok, usdgGot, out) = (true, got, coins);
        } catch {
            ok = false;
        }
        vm.revertToState(s);
    }

    /// Mirrors LaunchDeployer: the coin lands at CREATE2(deployer, keccak256(initiator ++ salt), initCodeHash). Tries
    /// salts derived from a fixed seed until the address ends in 6942 and sorts below the name, so the result is
    /// reproducible from the inputs. The loop works in a fixed scratch area of memory: hundreds of thousands of tries
    /// must not grow memory, or the script runs out of it.
    function _grindSalt(ILaunchDeployer deployer, address initiator, TokenParams memory p, uint256 supply, bytes32 seed, address below) internal view returns (bytes32 found) {
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
                if and(eq(and(a, 0xffff), 0x6942), lt(a, below)) {
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
