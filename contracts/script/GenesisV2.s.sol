// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {Factory} from "../src/Factory.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, Socials, LaunchConfig, LaunchedToken} from "../src/Types.sol";
import {ILaunchDeployer} from "../src/interfaces/ILaunchDeployer.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {UniversalRouterBuy, IUniversalRouter} from "./lib/UniversalRouterBuy.sol";
import {Permit2Batch} from "./lib/Permit2Batch.sol";

/// @notice The official coin of the v2 path: a new fixed-inventory name, a coin launched under it, and a disclosed
/// first buy, split between an airdrop and the treasury.
///
/// Nothing about the coin is written here. Its name, its symbol, the name's symbol and every piece of metadata come
/// from the environment, so this file can sit in the public copy before launch without saying what is coming.
///
/// Stages. A forge script works out every transaction in a simulation before it sends any, so an amount read from a
/// balance inside one run is the simulation's, not the chain's. The genesis is therefore split into stages, each its
/// own run, each reading the chain as the previous stage's confirmed receipts left it. `script/genesis-v2.mjs` runs
/// them in order, checks every receipt between them and keeps a journal, so an interrupted run resumes from what
/// the chain shows rather than from what was meant to happen. Each stage also refuses on its own when the chain is
/// not in the state it expects:
///
///   launch()    `createAndLaunch`, then the first buy, sent back to back: ETH to USDG to the name to the coin
///               through Uniswap's canonical Universal Router, whose TAKE_ALL pays the coin from the pool manager
///               straight to this wallet. Its minimum is the disclosed share. Refuses once the name exists.
///   buy()       only when the launch landed and its first buy did not: buys what is missing, sized now.
///   listName()  the name's listing buy, into this wallet, quoted now.
///   listCoin()  the coin's listing buy, quoted now. The runner sends it only once the name's receipt is confirmed,
///               so it lands in a later block, as the site's activation requires.
///   split()     from the balance the chain now shows: exactly the treasury's share to the treasury and everything
///               past the disclosed share to 0xdEaD, in one Permit2 transaction (script/lib/Permit2Batch.sol), so
///               the wallet is left holding exactly the airdrop, or nothing moved.
///   verify()    reads only. Checks the finished state on chain and only then writes the coin, its name and its pool
///               into the deployment record, which is what opens the site's create page.
///   plan()      reads only: the predicted addresses and amounts, for the runner.
///
/// What protects the first buy, and what does not. `MarketTickerLauncher` has no buy, and the generic
/// `LaunchAndBuyRouter` cannot launch under a v2 name because it goes around the registrar those names require, so
/// the first buy is a separate transaction. Between the two, the coin's own launch protection (`Token._update`) is
/// the guard: in the launch block no other wallet can take the coin out of the pool manager, for the next two blocks
/// other wallets are capped at 5% held and 5.5% bought, and for five seconds they pay the snipe tax. On Robinhood
/// Chain `block.number` is Ethereum's, so the launch block is about twelve seconds long. The launching wallet is
/// exempt. The coin's address is unknown until the launch lands, because its salt comes from a secret seed.
/// This is protection, not exclusivity: another sender's transaction can land between the launch and the buy, and a
/// buyer who settles into ERC-6909 claims inside the pool manager is not stopped by transfer-based rules at all
/// (docs 09). The buy's minimum bounds what it receives; it does not promise the price it was sized at or that it
/// comes first. If something got far enough ahead to push the output under the share, it reverts and `buy()` sizes
/// the rest again.
///
/// env (all required unless a default is named):
///   EXPECTED_CHAIN          the chain id this run is meant for; anything else stops it
///   PRIVATE_KEY             the launching wallet. It stays exempt from this coin's launch protection for good
///   TREASURY                receives the treasury's share and is the coin's creator-fee recipient
///   V2_SEED                 a random bytes32, secret until the launch lands: both salts come from it
///   V2_NAME_SYMBOL          the new name's symbol
///   V2_COIN_NAME, V2_COIN_SYMBOL
///   V2_COIN_LOGO, V2_COIN_DESCRIPTION, V2_COIN_X, V2_COIN_TELEGRAM, V2_COIN_DISCORD, V2_COIN_WEBSITE,
///   V2_COIN_FARCASTER       metadata, default empty. Every stage recomputes the coin's address from these, so they
///                           must stay the same from the launch to the end
///   V2_MAX_BUY_ETH          the most ETH every buy of this genesis may spend, together: the first buy, any re-sized
///                           recovery buy, and both listing buys. Each is checked against it before it is signed,
///                           with the buys still to come reserved, and a run stops rather than spend past it. The
///                           wallet's balance is not the approval. It does not cover the launch fee or gas
///   V2_BUY_BPS              the first buy as a share of supply
///   V2_TREASURY_BPS         the treasury's part of it; the rest is the airdrop
///   V2_EXTRA_KEPT           raw coins kept here on top of the airdrop's share, taken out of the surplus the buy
///                           brought in past the disclosed share — the part that is otherwise burned. It comes from
///                           neither the treasury's share nor the holders', and goes out with the airdrop, so nobody
///                           else has to sign anything. The split refuses if the surplus cannot cover it; default 0
///   CONFIG_ID               the enabled 82 bps configuration, default 2
///   V2_LISTING_NAME_ETH     default 0.0005 ether; V2_LISTING_COIN_ETH, default 0.001 ether: the reference's amounts
///   DEPLOY_RECORD           the record, relative to the project; default deployments/<chain id>.json
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
    /// burned by `split()`.
    uint256 internal constant BUY_MARGIN_BPS = 300;
    /// @dev Room for the transactions' own gas when checking the wallet can pay.
    uint256 internal constant GAS_ALLOWANCE = 0.01 ether;

    struct Ctx {
        Factory factory;
        ILaunchDeployer launchDeployer;
        MarketTickerLauncher launcher;
        MarketTickerDeployer names;
        address usdg;
        IUniversalRouter router;
        IV4Quoter quoter;
        IAllowanceTransfer permit2;
        uint256 configId;
        uint256 pk;
        uint256 buyBps;
        uint256 treasuryBps;
        uint256 extraKept;
        string nameSymbol;
        uint8 nameDecimals;
        bytes32 seed;
        string path;
        bool recorded;
    }

    /// @notice What the genesis will make and move, all of it fixed by the environment before anything is sent.
    struct Plan {
        address me;
        address treasury;
        address name;
        address coin;
        bytes32 nameSalt;
        uint256 supply;
        uint256 maxBuyEth; // the most ETH every buy may spend, together, the listing buys included: V2_MAX_BUY_ETH
        uint256 nameListingEth; // V2_LISTING_NAME_ETH
        uint256 coinListingEth; // V2_LISTING_COIN_ETH
        uint256 target; // the first buy, raw coins
        uint256 toTreasury; // the treasury's whole share
        uint256 kept; // what stays in the wallet for the airdrop
    }

    // ---------------------------------------------------------------------------------------------------------------
    // stages
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice The predicted name and coin and the amounts. Reads only.
    function plan() external view returns (Plan memory pl) {
        (, pl,) = _setup();
    }

    /// @notice The launch transaction exactly as stage 1 sends it. Reads only: the runner compares it byte for byte
    /// with the transaction that landed.
    function launchCall() external view returns (address to, uint256 value, bytes memory data) {
        (Ctx memory c, Plan memory pl, TokenParams memory p) = _setup();
        to = address(c.launcher);
        value = c.factory.launchFee();
        data = abi.encodeCall(MarketTickerLauncher.createAndLaunch, (pl.nameSalt, c.nameSymbol, c.nameDecimals, p, c.configId));
    }

    /// @notice Stage 1: the launch and the first buy, back to back.
    function launch() external returns (Plan memory pl, uint256 ethBuy) {
        Ctx memory c;
        TokenParams memory p;
        (c, pl, p) = _setup();
        _preflight(c);
        require(c.names.market(pl.name).token == address(0), "genesis v2: the name already exists, so the launch has run: go on from the next stage");

        ethBuy = _sizeLaunchBuy(c, pl, p);
        console.log("  genesis v2 first buy sized, wei", ethBuy);
        _withinBudget(pl, pl.nameListingEth + pl.coinListingEth, ethBuy); // the listing buys still to come are reserved
        _sendLaunch(c, pl, p, ethBuy);
        console.log("  genesis v2 launch and first buy sent");
    }

    /// @dev The two transactions of stage 1, back to back, once the wallet is known to cover them and the listing buys
    /// to come.
    function _sendLaunch(Ctx memory c, Plan memory pl, TokenParams memory p, uint256 ethBuy) internal {
        uint256 fee = c.factory.launchFee();
        uint256 listing = pl.nameListingEth + pl.coinListingEth;
        require(pl.me.balance >= fee + ethBuy + listing + GAS_ALLOWANCE, "genesis v2: the wallet cannot pay for the run");
        vm.startBroadcast(c.pk);
        (address gotName, address gotCoin,) = c.launcher.createAndLaunch{value: fee}(pl.nameSalt, c.nameSymbol, c.nameDecimals, p, c.configId);
        require(gotName == pl.name && gotCoin == pl.coin, "genesis v2: the launch did not land where predicted");
        UniversalRouterBuy.buy(c.router, pl.me, _route(c, pl.name, pl.coin, 3), ethBuy, pl.target, block.timestamp + 30 minutes);
        vm.stopBroadcast();
    }

    /// @notice Stage 1, again for the buy only: when the launch landed and its first buy did not.
    function buy() external returns (uint256 ethBuy) {
        (Ctx memory c, Plan memory pl,) = _setup();
        _requireLaunched(c, pl);
        require(IERC20(pl.name).balanceOf(pl.me) == 0, "genesis v2: the name's listing buy is in, so the first buy cannot be missing");
        uint256 have = IERC20(pl.coin).balanceOf(pl.me);
        require(have < pl.target, "genesis v2: the first buy is already in");
        uint256 need = pl.target - have;
        PoolKey[] memory route = _route(c, pl.name, pl.coin, 3);
        ethBuy = (_search(c, route, need) * (10_000 + BUY_MARGIN_BPS)) / 10_000;
        // what the buys have already spent, from the runner's journal; alone, this stage assumes nothing was spent.
        // the listing buys come after this one, so their amounts are reserved here too
        _withinBudget(pl, vm.envOr("V2_BUY_SPENT_WEI", uint256(0)) + pl.nameListingEth + pl.coinListingEth, ethBuy);
        require(pl.me.balance >= ethBuy + GAS_ALLOWANCE, "genesis v2: the wallet cannot pay for the buy");
        console.log("  genesis v2 missing coins, raw", need);
        vm.startBroadcast(c.pk);
        UniversalRouterBuy.buy(c.router, pl.me, route, ethBuy, need, block.timestamp + 30 minutes);
        vm.stopBroadcast();
    }

    /// @notice Stage 2: the name's listing buy, quoted against the chain as it is now.
    function listName() external {
        (Ctx memory c, Plan memory pl,) = _setup();
        _requireLaunched(c, pl);
        require(IERC20(pl.coin).balanceOf(pl.me) >= pl.target, "genesis v2: the first buy is not in: run buy()");
        require(IERC20(pl.name).balanceOf(pl.me) == 0, "genesis v2: the name's listing buy is already in");
        // the coin's listing buy is still to come, so it is reserved against the ceiling here
        _withinBudget(pl, vm.envOr("V2_BUY_SPENT_WEI", uint256(0)) + pl.coinListingEth, pl.nameListingEth);
        _listingBuy(c, pl, _route(c, pl.name, pl.coin, 2), pl.nameListingEth);
    }

    /// @notice Stage 3: the coin's listing buy, quoted now. The runner sends it only after the name's receipt.
    function listCoin() external {
        (Ctx memory c, Plan memory pl,) = _setup();
        _requireLaunched(c, pl);
        require(IERC20(pl.name).balanceOf(pl.me) > 0, "genesis v2: the name's listing buy comes first");
        require(IERC20(pl.coin).balanceOf(pl.me) >= pl.target, "genesis v2: the first buy is not in: run buy()");
        _withinBudget(pl, vm.envOr("V2_BUY_SPENT_WEI", uint256(0)), pl.coinListingEth);
        _listingBuy(c, pl, _route(c, pl.name, pl.coin, 3), pl.coinListingEth);
    }

    /// @notice Stage 4: the split, from the balance the chain shows now, in one transaction that moves coins.
    function split() external returns (uint256 toTreasury, uint256 burned) {
        (Ctx memory c, Plan memory pl,) = _setup();
        _requireLaunched(c, pl);
        require(IERC20(pl.name).balanceOf(pl.me) > 0, "genesis v2: the listing buys come before the split");
        uint256 have = IERC20(pl.coin).balanceOf(pl.me);
        // below the disclosed share means the split has already gone out (it is the only thing that lowers this
        // balance) or the first buy never landed; either way there is nothing to split
        require(have >= pl.target, "genesis v2: the wallet holds less than the first buy: split already, or the buy is missing");
        toTreasury = pl.toTreasury;
        require(have >= pl.target + c.extraKept, "genesis v2: the buy did not bring in enough past the share to cover V2_EXTRA_KEPT");
        burned = have - pl.target - c.extraKept;
        address[] memory to = new address[](burned > 0 ? 2 : 1);
        uint256[] memory amounts = new uint256[](to.length);
        (to[0], amounts[0]) = (pl.treasury, toTreasury);
        if (burned > 0) (to[1], amounts[1]) = (DEAD, burned);
        vm.startBroadcast(c.pk);
        Permit2Batch.send(c.permit2, pl.coin, pl.me, to, amounts);
        vm.stopBroadcast();
        console.log("  genesis v2 to the treasury, raw", toTreasury);
        console.log("  genesis v2 burned past the share, raw", burned);
        console.log("  genesis v2 kept for the airdrop, raw", pl.kept);
        if (c.extraKept > 0) console.log("  genesis v2 of which out of the surplus instead of burned, raw", c.extraKept);
    }

    /// @notice Stage 5: reads the finished genesis from the chain and, only if all of it checks, writes it into the
    /// record. Never under a broadcast: what it writes must describe confirmed state, not a simulation of sends.
    function verify() external returns (Plan memory pl, bytes32 poolId) {
        require(
            !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume),
            "genesis v2: verify reads only: run it without --broadcast"
        );
        Ctx memory c;
        (c, pl,) = _setup();
        poolId = _checkFinished(c, pl);
        console.log("  genesis v2 verified on chain: coin", pl.coin);
        console.log("  genesis v2 verified on chain: name", pl.name);

        if (c.recorded) {
            console.log("  record already holds this coin");
            return (pl, poolId);
        }
        vm.writeJson(vm.toString(pl.coin), c.path, ".genesisV2Token");
        vm.writeJson(vm.toString(pl.name), c.path, ".genesisV2Name");
        vm.writeJson(vm.toString(poolId), c.path, ".genesisV2Pool");
        // not the treasury: the site bundles this record into its public code, and the treasury's address is one
        // publish.sh keeps out of the public copy. It is on chain as the coin's creator-fee recipient anyway
        console.log("  genesis v2 recorded in", c.path);
    }

    /// @dev The finished genesis, as the chain shows it: the coin this wallet launched, under its name, on the planned
    /// fee terms, both listing buys' marks, exactly the airdrop left in the wallet, the treasury paid, and no
    /// allowance from the split left open.
    function _checkFinished(Ctx memory c, Plan memory pl) internal view returns (bytes32 poolId) {
        _requireLaunched(c, pl);
        poolId = c.factory.poolIdOf(pl.coin);
        require(poolId != bytes32(0), "genesis v2: the coin has no pool");
        require(
            c.factory.getLaunchedToken(pl.coin).creatorTaxBps == 0 && c.factory.creatorFeeRecipientOf(pl.coin) == pl.treasury,
            "genesis v2: the coin's fee terms are not the planned ones"
        );
        require(IERC20(pl.name).balanceOf(pl.me) > 0, "genesis v2: the name's listing buy is missing");
        require(IERC20(pl.coin).balanceOf(pl.me) == pl.kept, "genesis v2: the wallet does not hold exactly the airdrop");
        require(IERC20(pl.coin).balanceOf(pl.treasury) >= pl.toTreasury, "genesis v2: the treasury does not hold its share");
        require(Permit2Batch.spent(c.permit2, pl.coin, pl.me), "genesis v2: an allowance from the split is still open");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // the plan
    // ---------------------------------------------------------------------------------------------------------------

    function _setup() internal view returns (Ctx memory c, Plan memory pl, TokenParams memory p) {
        c = _context();
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "genesis v2: wrong chain");
        require(c.seed != bytes32(0), "genesis v2: set V2_SEED to a random bytes32");
        require(bytes(c.nameSymbol).length > 0, "genesis v2: no name symbol");
        require(address(c.names) == address(c.launcher.deployer()), "genesis v2: the record's name deployer is not the launcher's");
        c.nameDecimals = c.launcher.requiredDecimals();
        LaunchConfig memory cfg = c.factory.getLaunchConfig(c.configId);
        pl.me = vm.addr(c.pk);
        pl.treasury = vm.envAddress("TREASURY");
        pl.supply = cfg.supply;
        require(pl.treasury != address(0) && pl.treasury != pl.me, "genesis v2: the treasury must be a separate wallet");
        require(c.buyBps > c.treasuryBps && c.buyBps <= 1_000, "genesis v2: the buy must exceed the treasury's part and stay within 10%");
        pl.maxBuyEth = vm.envUint("V2_MAX_BUY_ETH");
        pl.nameListingEth = vm.envOr("V2_LISTING_NAME_ETH", uint256(0.0005 ether));
        pl.coinListingEth = vm.envOr("V2_LISTING_COIN_ETH", uint256(0.001 ether));
        require(pl.maxBuyEth > pl.nameListingEth + pl.coinListingEth, "genesis v2: V2_MAX_BUY_ETH must cover the listing buys and the first buy");
        pl.target = (pl.supply * c.buyBps) / 10_000;
        require(c.extraKept <= pl.target / 20, "genesis v2: V2_EXTRA_KEPT is more than a twentieth of the buy: check the figure");
        pl.toTreasury = (pl.supply * c.treasuryBps) / 10_000;
        // what the wallet keeps: the airdrop's share, plus anything paid out of the surplus the buy brought in past
        // the disclosed share — the part that is otherwise burned. It comes from neither the treasury's share nor
        // the holders', and the split refuses if the surplus cannot cover it
        pl.kept = pl.target - pl.toTreasury + c.extraKept;

        // the name, somewhere high so that nearly any coin address sorts below it
        (pl.nameSalt, pl.name) = _grindName(c);
        // the coin: its parameters, and a salt that ends its address in 6942 below the name
        p = _params(c, pl);
        p.salt = _grindSalt(c.launchDeployer, pl.me, p, pl.supply, c.seed, pl.name);
        pl.coin = c.launchDeployer.predictToken(pl.me, p, pl.supply);
        require(uint16(uint160(pl.coin)) == VANITY_SUFFIX, "genesis v2: the predicted coin does not end in 6942");
        require(pl.coin < pl.name, "genesis v2: the coin must sort below its name");
        if (c.recorded) {
            require(vm.readFile(c.path).readAddress(".genesisV2Token") == pl.coin, "genesis v2: the record holds a different v2 genesis coin");
        }
    }

    function _context() internal view returns (Ctx memory c) {
        c.path = string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        string memory j = vm.readFile(c.path);
        c.recorded = vm.keyExistsJson(j, ".genesisV2Token");
        require(vm.keyExistsJson(j, ".universalRouter") && vm.keyExistsJson(j, ".v4Quoter") && vm.keyExistsJson(j, ".permit2"), "genesis v2: the record has no Universal Router, quoter or Permit2");
        c.factory = Factory(payable(j.readAddress(".factory")));
        c.launchDeployer = ILaunchDeployer(j.readAddress(".launchDeployer"));
        c.launcher = MarketTickerLauncher(j.readAddress(".marketTickerLauncher"));
        c.names = MarketTickerDeployer(j.readAddress(".marketTickerDeployer"));
        c.usdg = j.readAddress(".usdg");
        c.router = IUniversalRouter(j.readAddress(".universalRouter"));
        c.quoter = IV4Quoter(j.readAddress(".v4Quoter"));
        c.permit2 = IAllowanceTransfer(j.readAddress(".permit2"));
        c.configId = vm.envOr("CONFIG_ID", uint256(2));
        c.pk = vm.envUint("PRIVATE_KEY");
        c.buyBps = vm.envUint("V2_BUY_BPS");
        c.treasuryBps = vm.envUint("V2_TREASURY_BPS");
        c.extraKept = vm.envOr("V2_EXTRA_KEPT", uint256(0));
        c.nameSymbol = vm.envString("V2_NAME_SYMBOL");
        c.seed = vm.envBytes32("V2_SEED");
    }

    /// @dev The buys may spend `V2_MAX_BUY_ETH` and no more, counting every buy together: `spent` is what earlier buys
    /// took plus what the buys still to come are reserved. A wallet's balance is not
    /// permission: a buy re-sized after someone else moved the price can cost more than the one that was approved, and
    /// raising the ceiling for it is a decision, taken deliberately, not something a script does on its own.
    function _withinBudget(Plan memory pl, uint256 spent, uint256 more) internal pure {
        require(
            spent + more <= pl.maxBuyEth,
            "genesis v2: the buy would take the ETH spent on buys past V2_MAX_BUY_ETH: review the price and raise it deliberately"
        );
    }

    /// @dev What only the launch needs: the record not yet marked, the enabled 82 bps configuration, a wallet the
    /// factory lets launch, and the v2 launcher still a registrar.
    function _preflight(Ctx memory c) internal view {
        require(!c.recorded, "genesis v2: the record already has a v2 genesis coin");
        LaunchConfig memory cfg = c.factory.getLaunchConfig(c.configId);
        require(cfg.enabled && cfg.baseFeeBps == 82, "genesis v2: the configuration is not the enabled 82 bps one");
        require(c.factory.launchEnabled() && c.factory.canLaunch(vm.addr(c.pk)), "genesis v2: this wallet cannot launch");
        require(c.factory.registrars(address(c.launcher)), "genesis v2: the v2 launcher is not a registrar");
    }

    /// @dev Every stage after the launch acts only on the coin this wallet launched, at the predicted address, under
    /// the predicted name. Metadata changed since the launch predicts another address, and stops here.
    function _requireLaunched(Ctx memory c, Plan memory pl) internal view {
        LaunchedToken memory t = c.factory.getLaunchedToken(pl.coin);
        require(t.exists && t.deployer == pl.me && t.pairToken == pl.name, "genesis v2: no coin launched by this wallet at the predicted address: is the env the launch's?");
        require(c.names.market(pl.name).token == pl.name, "genesis v2: the name is not a v2 market");
    }

    /// @dev Tries salts derived from the seed until the name lands with a top nibble of 0xF. The coin must sort below
    /// its name, so a high name leaves fifteen coin addresses in sixteen eligible.
    function _grindName(Ctx memory c) internal view returns (bytes32 salt, address name) {
        for (uint256 i; i < 4_096; i++) {
            salt = keccak256(abi.encodePacked(c.seed, "name", i));
            name = c.launcher.predictName(salt, c.nameSymbol, c.nameDecimals);
            if (uint160(name) >> 156 == 0xF) return (salt, name);
        }
        revert("genesis v2: no name salt found");
    }

    function _params(Ctx memory c, Plan memory pl) internal view returns (TokenParams memory p) {
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
            creatorFeeRecipient: pl.treasury,
            creatorTaxBps: 0, // the v2 path refuses any other value
            buybackEnabled: false, // the creator's whole share goes to the treasury, as with the v1 official coin
            expectedEconomics: c.launcher.previewEconomics(c.configId, pl.name),
            salt: bytes32(0)
        });
        require(bytes(p.name).length > 0 && bytes(p.symbol).length > 0, "genesis v2: the coin needs a name and a symbol");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // buying
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev ETH to USDG, USDG to the name, and with `hops` = 3 the name to the coin.
    function _route(Ctx memory c, address name, address coin, uint256 hops) internal view returns (PoolKey[] memory r) {
        r = new PoolKey[](hops);
        r[0] = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(c.usdg), fee: FEE_ETH_USDG, tickSpacing: TICK_ETH_USDG, hooks: IHooks(address(0))});
        r[1] = c.names.keyFor(name);
        if (hops == 3) r[2] = c.factory.poolKeyOf(coin);
    }

    /// @dev The ETH that buys the disclosed share, found against a launch made in a simulation and thrown away. The
    /// launch is the same as the real one, so the pools are the same; the margin covers the ETH/USDG pool moving in
    /// between, and what the margin buys past the share is burned by `split()`.
    function _sizeLaunchBuy(Ctx memory c, Plan memory pl, TokenParams memory p) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        vm.deal(pl.me, pl.me.balance + 50 ether);
        uint256 fee = c.factory.launchFee();
        vm.startPrank(pl.me);
        c.launcher.createAndLaunch{value: fee}(pl.nameSalt, c.nameSymbol, c.nameDecimals, p, c.configId);
        vm.stopPrank();
        uint256 eth = _search(c, _route(c, pl.name, pl.coin, 3), pl.target);
        vm.revertToState(snap);
        return (eth * (10_000 + BUY_MARGIN_BPS)) / 10_000;
    }

    /// @dev The least ETH, to forty halvings between a ten-thousandth and ten ETH, that the quoter says buys `want`.
    function _search(Ctx memory c, PoolKey[] memory route, uint256 want) internal returns (uint256) {
        uint256 lo = 0.0001 ether;
        uint256 hi = 10 ether;
        for (uint256 i; i < 40; i++) {
            uint256 mid = (lo + hi) / 2;
            // more ETH buys more coins until the route cannot absorb it, and then the quote fails. A failed quote is
            // therefore "too much", never "too little": treating it as too little walks the search up and away from
            // the answer, which a shallow dollar pool (the Sepolia rehearsal's) shows at once
            uint256 out = _quote(c, route, mid);
            if (out != 0 && out < want) lo = mid;
            else hi = mid;
        }
        require(_quote(c, route, hi) >= want, "genesis v2: the route cannot fill the buy");
        return hi;
    }

    function _quote(Ctx memory c, PoolKey[] memory route, uint256 amountIn) internal returns (uint256 out) {
        (PathKey[] memory keys,) = UniversalRouterBuy.path(route);
        try c.quoter.quoteExactInput(IV4Quoter.QuoteExactParams({exactCurrency: Currency.wrap(address(0)), path: keys, exactAmount: uint128(amountIn)})) returns (uint256 got, uint256) {
            out = got;
        } catch {
            out = 0;
        }
    }

    /// @dev One listing buy to this wallet, exactly as every launch under a name sends it: a quote taken now, outside
    /// the broadcast, one percent under.
    function _listingBuy(Ctx memory c, Plan memory pl, PoolKey[] memory route, uint256 eth) internal {
        require(pl.me.balance >= eth + GAS_ALLOWANCE, "genesis v2: the wallet cannot pay for the listing buy");
        uint256 minOut = UniversalRouterBuy.minimum(UniversalRouterBuy.quote(c.quoter, route, eth));
        vm.startBroadcast(c.pk);
        UniversalRouterBuy.buy(c.router, pl.me, route, eth, minOut, block.timestamp + 30 minutes);
        vm.stopBroadcast();
        console.log("  genesis v2 listing buy sent, hops", route.length);
    }

    /// Mirrors LaunchDeployer, exactly as `Genesis.s.sol` does: the coin lands at CREATE2(deployer, keccak256(initiator
    /// ++ salt), initCodeHash). Tries salts derived from the seed until the address ends in 6942 and sorts below the
    /// name. The loop works in a fixed scratch area of memory, so hundreds of thousands of tries never grow it.
    function _grindSalt(ILaunchDeployer deployer, address initiator, TokenParams memory p, uint256 supply, bytes32 seed, address below) internal view returns (bytes32 found) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(Token).creationCode, abi.encode(p.name, p.symbol, p.logo, p.description, p.socials, supply, deployer.factory()))
        );
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
                    break
                }
            }
        }
        require(found != bytes32(0), "genesis v2: no coin salt found");
    }
}
