// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {Factory} from "../src/Factory.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, Socials, LaunchConfig} from "../src/Types.sol";
import {ILaunchDeployer} from "../src/interfaces/ILaunchDeployer.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {UniversalRouterBuy, IUniversalRouter} from "./lib/UniversalRouterBuy.sol";

/// @notice The official coin of the v2 path: a new fixed-inventory name, a coin launched under it, and a disclosed
/// first buy, split between an airdrop and the treasury.
///
/// Nothing about the coin is written here. Its name, its symbol, the name's symbol and every piece of metadata come
/// from the environment, so this file can sit in the public copy before launch without saying what is coming.
///
/// Why this is not `Genesis.s.sol`. That script launches and buys in one transaction through
/// `TickerLauncher.launchAndBuy`, so nothing can trade the pool before the treasury holds its slice. The v2 path has
/// no buy: `MarketTickerLauncher` only launches, and the generic `LaunchAndBuyRouter` cannot launch under a v2 name
/// because it goes around the registrar those names require. So the first buy is the very next transaction, and what
/// guards the gap is the coin's own launch protection (`Token._update`):
///
///   - in the launch block only the launch's own wallets may buy at all, so a buy that lands in the same block as
///     the launch cannot be preceded. On Robinhood Chain `block.number` is the parent chain's (Ethereum's) block
///     number, not the L2's, so that block is about twelve seconds long: a buy sent right behind the launch lands
///     inside it;
///   - for the next two of those blocks every other wallet is capped at 5% held and 5.5% bought, and for the first
///     five seconds pays the snipe tax (99% in second 0, 25% in second 1);
///   - the launching wallet is exempt from all of it, so the disclosed share goes through uncapped and untaxed;
///   - the coin's address is unknown to anyone until the launch lands, because its salt comes from a secret seed.
///
/// The buy carries the disclosed share as its minimum. If anything got in front of it far enough to move the price
/// past the margin, it reverts rather than paying more than it was sized for.
///
/// In order, all from the launching wallet:
///   1. `createAndLaunch`: the name is made and the coin launched under it.
///   2. The first buy: ETH to USDG to the name to the coin, through Uniswap's canonical Universal Router, whose
///      TAKE_ALL pays the coin out of the pool manager straight to this wallet. Nothing between them holds it, so
///      the exemption applies to the buy itself.
///   3. The two listing buys, exactly as every launch under a name sends them: the name into the wallet, then the
///      coin. Chart sites price a name from a swap that lands in a wallet and a coin from a buy after its launch.
///   4. The split: exactly the treasury's share to the treasury, exactly the airdrop's share kept here for
///      `AirdropV2.s.sol`, and everything the buys brought in past the disclosed share burned, so the published
///      figures are exact rather than approximately right.
///
/// env (all required unless a default is named):
///   EXPECTED_CHAIN          the chain id this run is meant for; anything else stops it
///   PRIVATE_KEY             the launching wallet. It stays exempt from this coin's launch protection for good
///   TREASURY                receives the treasury's share and is the coin's creator-fee recipient
///   V2_SEED                 a random bytes32, secret until the launch lands: both salts come from it
///   V2_NAME_SYMBOL          the new name's symbol
///   V2_COIN_NAME, V2_COIN_SYMBOL
///   V2_COIN_LOGO, V2_COIN_DESCRIPTION, V2_COIN_X, V2_COIN_TELEGRAM, V2_COIN_DISCORD, V2_COIN_WEBSITE,
///   V2_COIN_FARCASTER       metadata, default empty
///   V2_BUY_BPS              the first buy as a share of supply
///   V2_TREASURY_BPS         the treasury's part of it; the rest is the airdrop
///   V2_TREASURY_HOLDBACK    raw coins of the treasury's part kept here instead, to go out with the airdrop on the
///                           treasury's behalf (a wallet paid from the team's share rather than the holders'), so the
///                           treasury never has to sign anything; default 0
///   CONFIG_ID               the enabled 82 bps configuration, default 2
///   V2_LISTING_NAME_ETH     default 0.0005 ether; V2_LISTING_COIN_ETH, default 0.001 ether: the reference's amounts
///
/// Refuses to run twice: once the record carries `genesisV2Token`, it stops.
///
/// This file holds one contract and must stay that way (`forge script` needs `--tc` otherwise). Helpers live in
/// script/lib.
contract GenesisV2 is Script {
    using stdJson for string;

    uint24 internal constant FEE_ETH_USDG = 100;
    int24 internal constant TICK_ETH_USDG = 1;
    uint16 internal constant VANITY_SUFFIX = 0x6942;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev ETH on top of the sized amount, so a move in the ETH/USDG pool between sizing and sending, or a small
    /// buy landing first, still leaves the output at or above the disclosed share. What it buys past the share is
    /// burned in step 4.
    uint256 internal constant BUY_MARGIN_BPS = 300;
    /// @dev Room for the transactions' own gas when checking the wallet can pay for the run.
    uint256 internal constant GAS_ALLOWANCE = 0.01 ether;

    struct Ctx {
        Factory factory;
        ILaunchDeployer launchDeployer;
        MarketTickerLauncher launcher;
        MarketTickerDeployer names;
        address usdg;
        IUniversalRouter router;
        IV4Quoter quoter;
        uint256 configId;
        uint256 pk;
        address me;
        address treasury;
        uint256 supply;
        uint256 buyBps;
        uint256 treasuryBps;
        uint256 holdback;
        string nameSymbol;
        uint8 nameDecimals;
        bytes32 seed;
        string path;
    }

    struct Result {
        address name;
        address coin;
        bytes32 poolId;
        uint256 ethBuy;
        uint256 bought;
        uint256 toTreasury;
        uint256 kept;
        uint256 burned;
    }

    function run() external returns (Result memory r) {
        Ctx memory c = _context();
        _preflight(c);

        // 1. the name, somewhere high so that nearly any coin address sorts below it
        bytes32 nameSalt;
        (nameSalt, r.name) = _grindName(c);

        // 2. the coin: its parameters, and a salt that ends its address in 6942 below the name
        TokenParams memory p = _params(c, r.name);
        p.salt = _grindSalt(c.launchDeployer, c.me, p, c.supply, c.seed, r.name);
        r.coin = c.launchDeployer.predictToken(c.me, p, c.supply);
        require(uint16(uint160(r.coin)) == VANITY_SUFFIX, "genesis v2: the predicted coin does not end in 6942");
        require(r.coin < r.name, "genesis v2: the coin must sort below its name");
        console.log("  genesis v2 name predicted", r.name);
        console.log("  genesis v2 coin predicted", r.coin);

        // 3. the first buy, sized in a simulation of the launch it follows, then thrown away
        uint256 target = (c.supply * c.buyBps) / 10_000;
        r.ethBuy = _sizeBuy(c, nameSalt, p, r.name, r.coin, target);
        uint256 nameEth = vm.envOr("V2_LISTING_NAME_ETH", uint256(0.0005 ether));
        uint256 coinEth = vm.envOr("V2_LISTING_COIN_ETH", uint256(0.001 ether));
        uint256 fee = c.factory.launchFee();
        require(c.me.balance >= fee + r.ethBuy + nameEth + coinEth + GAS_ALLOWANCE, "genesis v2: the wallet cannot pay for the run");
        console.log("  genesis v2 first buy sized, wei", r.ethBuy);

        vm.startBroadcast(c.pk);

        // 4. launch
        address gotName;
        address gotCoin;
        (gotName, gotCoin, r.poolId) = c.launcher.createAndLaunch{value: fee}(nameSalt, c.nameSymbol, c.nameDecimals, p, c.configId);
        require(gotName == r.name && gotCoin == r.coin, "genesis v2: the launch did not land where predicted");

        // 5. the first buy, the very next transaction, with the disclosed share as its minimum
        PoolKey[] memory toCoin = _route(c, r.name, r.coin, 3);
        UniversalRouterBuy.buy(c.router, c.me, toCoin, r.ethBuy, target, block.timestamp + 30 minutes);
        r.bought = IERC20(r.coin).balanceOf(c.me);
        require(r.bought >= target, "genesis v2: the first buy came in under the disclosed share");
        console.log("  genesis v2 first buy, coins", r.bought / 1e18);

        // 6. the two listing buys
        _list(c, r.name, r.coin, nameEth, coinEth);

        // 7. the split: exact shares out, everything past them burned. The holdback is the treasury's, kept here to
        //    go out with the airdrop on its behalf
        r.toTreasury = (c.supply * c.treasuryBps) / 10_000 - c.holdback;
        r.kept = target - r.toTreasury;
        IERC20(r.coin).transfer(c.treasury, r.toTreasury);
        r.burned = IERC20(r.coin).balanceOf(c.me) - r.kept;
        if (r.burned > 0) IERC20(r.coin).transfer(DEAD, r.burned);

        vm.stopBroadcast();

        require(IERC20(r.coin).balanceOf(c.me) == r.kept, "genesis v2: the wallet does not hold exactly the airdrop");
        console.log("  genesis v2 to the treasury", r.toTreasury / 1e18);
        console.log("  genesis v2 kept for the airdrop", r.kept / 1e18);
        if (c.holdback > 0) console.log("  genesis v2 of which held back from the treasury's share, raw", c.holdback);
        console.log("  genesis v2 burned past the share", r.burned);

        // a dry run must never mark the record: written under a broadcast only, or when asked for with WRITE_RECORD=true
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.envOr("WRITE_RECORD", false)) {
            vm.writeJson(vm.toString(r.coin), c.path, ".genesisV2Token");
            vm.writeJson(vm.toString(r.name), c.path, ".genesisV2Name");
            vm.writeJson(vm.toString(r.poolId), c.path, ".genesisV2Pool");
            // not the treasury: the site bundles this record into its public code, and the treasury's address is one
            // publish.sh keeps out of the public copy. It is on chain as the coin's creator-fee recipient anyway
            console.log("  genesis v2 recorded in", c.path);
        } else {
            console.log("  record not written: no broadcast (set WRITE_RECORD=true to write from a dry run)");
        }
    }

    function _context() internal view returns (Ctx memory c) {
        c.path = string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        string memory j = vm.readFile(c.path);
        require(!vm.keyExistsJson(j, ".genesisV2Token"), "genesis v2: the record already has a v2 genesis coin");
        require(vm.keyExistsJson(j, ".universalRouter") && vm.keyExistsJson(j, ".v4Quoter"), "genesis v2: the record has no Universal Router or quoter");
        c.factory = Factory(payable(j.readAddress(".factory")));
        c.launchDeployer = ILaunchDeployer(j.readAddress(".launchDeployer"));
        c.launcher = MarketTickerLauncher(j.readAddress(".marketTickerLauncher"));
        c.names = MarketTickerDeployer(j.readAddress(".marketTickerDeployer"));
        c.usdg = j.readAddress(".usdg");
        c.router = IUniversalRouter(j.readAddress(".universalRouter"));
        c.quoter = IV4Quoter(j.readAddress(".v4Quoter"));
        c.configId = vm.envOr("CONFIG_ID", uint256(2));
        c.pk = vm.envUint("PRIVATE_KEY");
        c.me = vm.addr(c.pk);
        c.treasury = vm.envAddress("TREASURY");
        c.buyBps = vm.envUint("V2_BUY_BPS");
        c.treasuryBps = vm.envUint("V2_TREASURY_BPS");
        c.holdback = vm.envOr("V2_TREASURY_HOLDBACK", uint256(0));
        c.nameSymbol = vm.envString("V2_NAME_SYMBOL");
        c.seed = vm.envBytes32("V2_SEED");
    }

    function _preflight(Ctx memory c) internal view {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "genesis v2: wrong chain");
        require(c.seed != bytes32(0), "genesis v2: set V2_SEED to a random bytes32");
        require(c.treasury != address(0) && c.treasury != c.me, "genesis v2: the treasury must be a separate wallet");
        require(c.buyBps > c.treasuryBps && c.buyBps <= 1_000, "genesis v2: the buy must exceed the treasury's part and stay within 10%");
        require(bytes(c.nameSymbol).length > 0, "genesis v2: no name symbol");
        LaunchConfig memory cfg = c.factory.getLaunchConfig(c.configId);
        require(cfg.enabled && cfg.baseFeeBps == 82, "genesis v2: the configuration is not the enabled 82 bps one");
        c.supply = cfg.supply;
        require(c.holdback < (c.supply * c.treasuryBps) / 10_000, "genesis v2: the holdback must be less than the treasury's share");
        require(c.factory.launchEnabled() && c.factory.canLaunch(c.me), "genesis v2: this wallet cannot launch");
        require(c.factory.registrars(address(c.launcher)), "genesis v2: the v2 launcher is not a registrar");
        require(address(c.names) == address(c.launcher.deployer()), "genesis v2: the record's name deployer is not the launcher's");
        c.nameDecimals = c.launcher.requiredDecimals();
    }

    /// @dev Tries salts derived from the seed until the name lands with a top nibble of 0xF. The coin must sort below
    /// its name, so a high name leaves fifteen coin addresses in sixteen eligible. A name already made there is refused.
    function _grindName(Ctx memory c) internal view returns (bytes32 salt, address name) {
        for (uint256 i; i < 4_096; i++) {
            salt = keccak256(abi.encodePacked(c.seed, "name", i));
            name = c.launcher.predictName(salt, c.nameSymbol, c.nameDecimals);
            if (uint160(name) >> 156 == 0xF) {
                require(c.names.market(name).token == address(0), "genesis v2: that name already exists");
                return (salt, name);
            }
        }
        revert("genesis v2: no name salt found");
    }

    function _params(Ctx memory c, address name) internal view returns (TokenParams memory p) {
        p = TokenParams({
            name: vm.envString("V2_COIN_NAME"),
            symbol: vm.envString("V2_COIN_SYMBOL"),
            logo: vm.envOr("V2_COIN_LOGO", string("")),
            description: vm.envOr("V2_COIN_DESCRIPTION", string("")),
            socials: Socials(
                vm.envOr("V2_COIN_X", string("")),
                vm.envOr("V2_COIN_TELEGRAM", string("")),
                vm.envOr("V2_COIN_DISCORD", string("")),
                vm.envOr("V2_COIN_WEBSITE", string("")),
                vm.envOr("V2_COIN_FARCASTER", string(""))
            ),
            creatorFeeRecipient: c.treasury,
            creatorTaxBps: 0, // the v2 path refuses any other value
            buybackEnabled: false, // the creator's whole share goes to the treasury, as with the v1 official coin
            expectedEconomics: c.launcher.previewEconomics(c.configId, name),
            salt: bytes32(0)
        });
        require(bytes(p.name).length > 0 && bytes(p.symbol).length > 0, "genesis v2: the coin needs a name and a symbol");
    }

    /// @dev ETH to USDG, USDG to the name, and with `hops` = 3 the name to the coin.
    function _route(Ctx memory c, address name, address coin, uint256 hops) internal view returns (PoolKey[] memory r) {
        r = new PoolKey[](hops);
        r[0] = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(c.usdg), fee: FEE_ETH_USDG, tickSpacing: TICK_ETH_USDG, hooks: IHooks(address(0))});
        r[1] = c.names.keyFor(name);
        if (hops == 3) r[2] = c.factory.poolKeyOf(coin);
    }

    /// @dev The ETH that buys `target` coins, found against a launch made in a simulation and thrown away. Forty
    /// halvings between a ten-thousandth and ten ETH. A quote the route cannot give counts as too much. The launch is
    /// the same as the real one, so the pools are the same; the margin covers the ETH/USDG pool moving in between.
    function _sizeBuy(Ctx memory c, bytes32 nameSalt, TokenParams memory p, address name, address coin, uint256 target) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        vm.deal(c.me, c.me.balance + 50 ether);
        uint256 fee = c.factory.launchFee();
        vm.startPrank(c.me);
        c.launcher.createAndLaunch{value: fee}(nameSalt, c.nameSymbol, c.nameDecimals, p, c.configId);
        vm.stopPrank();
        PoolKey[] memory route = _route(c, name, coin, 3);
        uint256 lo = 0.0001 ether;
        uint256 hi = 10 ether;
        for (uint256 i; i < 40; i++) {
            uint256 mid = (lo + hi) / 2;
            // more ETH buys more coins until the route cannot absorb it, and then the quote fails. A failed quote is
            // therefore "too much", never "too little": treating it as too little walks the search up and away from
            // the answer, which a shallow dollar pool (the Sepolia rehearsal's) shows at once
            uint256 out = _quote(c, route, mid);
            if (out != 0 && out < target) lo = mid;
            else hi = mid;
        }
        require(_quote(c, route, hi) >= target, "genesis v2: the route cannot fill the first buy");
        vm.revertToState(snap);
        return (hi * (10_000 + BUY_MARGIN_BPS)) / 10_000;
    }

    function _quote(Ctx memory c, PoolKey[] memory route, uint256 amountIn) internal returns (uint256 out) {
        (PathKey[] memory keys,) = UniversalRouterBuy.path(route);
        try c.quoter.quoteExactInput(IV4Quoter.QuoteExactParams({exactCurrency: Currency.wrap(address(0)), path: keys, exactAmount: uint128(amountIn)})) returns (uint256 got, uint256) {
            out = got;
        } catch {
            out = 0;
        }
    }

    /// @dev The two listing buys, one transaction each, both to this wallet: the name through its own pool, then the
    /// coin through the name's pool and its own. Each quote is taken outside the broadcast, one percent under.
    function _list(Ctx memory c, address name, address coin, uint256 nameEth, uint256 coinEth) internal {
        PoolKey[] memory toName = _route(c, name, coin, 2);
        PoolKey[] memory toCoin = _route(c, name, coin, 3);
        vm.stopBroadcast();
        uint256 minName = UniversalRouterBuy.minimum(UniversalRouterBuy.quote(c.quoter, toName, nameEth));
        vm.startBroadcast(c.pk);
        UniversalRouterBuy.buy(c.router, c.me, toName, nameEth, minName, block.timestamp + 30 minutes);
        vm.stopBroadcast();
        uint256 minCoin = UniversalRouterBuy.minimum(UniversalRouterBuy.quote(c.quoter, toCoin, coinEth));
        vm.startBroadcast(c.pk);
        UniversalRouterBuy.buy(c.router, c.me, toCoin, coinEth, minCoin, block.timestamp + 30 minutes);
        console.log("  genesis v2 listing buys sent: name, then coin");
    }

    /// Mirrors LaunchDeployer, exactly as `Genesis.s.sol` does: the coin lands at CREATE2(deployer, keccak256(initiator
    /// ++ salt), initCodeHash). Tries salts derived from the seed until the address ends in 6942 and sorts below the
    /// name. The loop works in a fixed scratch area of memory, so hundreds of thousands of tries never grow it.
    function _grindSalt(ILaunchDeployer deployer, address initiator, TokenParams memory p, uint256 supply, bytes32 seed, address below) internal view returns (bytes32 found) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(Token).creationCode, abi.encode(p.name, p.symbol, p.logo, p.description, p.socials, supply, deployer.factory()))
        );
        uint256 tries;
        assembly ("memory-safe") {
            let buf := mload(0x40)
            mstore(0x40, add(buf, 0x100))
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
        require(found != bytes32(0), "genesis v2: no coin salt found");
        console.log("  genesis v2 coin salt found after tries", tries);
    }
}
