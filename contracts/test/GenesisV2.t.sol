// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Fork} from "./Fork.sol";
import {GenesisV2} from "../script/GenesisV2.s.sol";
import {AirdropV2} from "../script/AirdropV2.s.sol";
import {Factory} from "../src/Factory.sol";
import {Token} from "../src/Token.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {UniversalRouterBuy, IUniversalRouter} from "../script/lib/UniversalRouterBuy.sol";

/// @dev A buyer who never takes the coin out of the pool manager: it swaps and keeps the output as ERC-6909 claims,
/// which no transfer rule of the coin sees. The known way around launch protection (docs 09), used here to put a
/// real competitor between the launch and the first buy.
contract ClaimBuyer is IUnlockCallback {
    IPoolManager internal immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function buy(PoolKey[] memory route) external payable returns (uint256) {
        return abi.decode(pm.unlock(abi.encode(true, abi.encode(route, msg.value))), (uint256));
    }

    /// @dev Claims back to coins, handed to `to`: what a claim holder can do at any time, protection or not.
    function redeem(Currency coin, address to, uint256 amount) external {
        pm.unlock(abi.encode(false, abi.encode(coin, to, amount)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not the pool manager");
        (bool buying, bytes memory inner) = abi.decode(data, (bool, bytes));
        if (!buying) {
            (Currency coin, address to, uint256 give) = abi.decode(inner, (Currency, address, uint256));
            pm.burn(address(this), coin.toId(), give);
            pm.take(coin, to, give);
            return "";
        }
        (PoolKey[] memory route, uint256 ethIn) = abi.decode(inner, (PoolKey[], uint256));
        Currency input = Currency.wrap(address(0));
        int256 amount = -int256(ethIn);
        uint256 out;
        for (uint256 i; i < route.length; i++) {
            PoolKey memory k = route[i];
            bool zeroForOne = Currency.unwrap(k.currency0) == Currency.unwrap(input);
            BalanceDelta d = pm.swap(
                k, SwapParams({zeroForOne: zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), ""
            );
            out = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
            input = zeroForOne ? k.currency1 : k.currency0;
            amount = -int256(out);
        }
        pm.settle{value: ethIn}();
        pm.mint(address(this), input.toId(), out);
        return abi.encode(out);
    }
}

/// @notice `GenesisV2.s.sol`'s stages and `AirdropV2.s.sol`, run as written against live mainnet state: the real
/// factory, the real v2 launcher, the real ETH/USDG pool, the canonical Universal Router and Permit2.
///
/// Each stage is called the way the runner calls it, one after another, each reading the state the previous one
/// left. Two runs from the same starting state: the straight one, and one with a competitor between the launch and
/// the first buy, where the first buy as sized fails, `buy()` recovers, and coins sent to the wallet uninvited are
/// burned by the split rather than left over. The record the stages write is a copy, never the live one.
///
/// One test, run in order, on purpose. The scripts read their inputs from the environment, the environment belongs
/// to the whole process, and forge runs tests in parallel: several tests setting different values would read each
/// other's. The shares default to values that are not the planned ones, so this file says nothing about a coming
/// launch; `TEST_V2_BUY_BPS`, `TEST_V2_TREASURY_BPS` and `TEST_V2_EXTRA_KEPT` set others, and `TEST_AIRDROP_FILE` runs
/// the airdrop from a real list, whose total must then equal what the genesis kept. Without `FORK_RPC` the test does
/// nothing, like every fork suite.
contract GenesisV2ForkTest is Test {
    using stdJson for string;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant PK = 0xA11CE;
    string internal constant RECORD = "deployments/genesis-v2-test-record.json";
    string internal constant NOT_LAUNCHED = "genesis v2: no coin launched by this wallet at the predicted address: is the env the launch's?";
    string internal constant OVER_BUDGET = "genesis v2: the buy would take the ETH spent on buys past V2_MAX_BUY_ETH: review the price and raise it deliberately";

    string internal live;
    GenesisV2 internal g;
    GenesisV2.Plan internal pl;

    function test_fork_genesisV2_stagedFromTheChain() public {
        if (!Fork.select()) return;
        live = vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        vm.writeFile(_recordPath(), live);
        vm.setEnv("DEPLOY_RECORD", RECORD);
        _setEnv();
        g = new GenesisV2();

        // a run meant for another chain stops before anything else
        vm.setEnv("EXPECTED_CHAIN", "1");
        vm.expectRevert(bytes("genesis v2: wrong chain"));
        g.launch();
        vm.setEnv("EXPECTED_CHAIN", vm.toString(block.chainid));

        pl = g.plan();
        assertEq(uint16(uint160(pl.coin)), 0x6942, "the coin ends in 6942");
        assertLt(uint160(pl.coin), uint160(pl.name), "the coin sorts below its name");
        assertEq(uint160(pl.name) >> 156, 0xF, "the name was ground high");

        // before the launch, no later stage has anything to act on
        vm.expectRevert(bytes(NOT_LAUNCHED));
        g.buy();
        vm.expectRevert(bytes(NOT_LAUNCHED));
        g.listName();
        vm.expectRevert(bytes(NOT_LAUNCHED));
        g.split();
        vm.expectRevert(bytes(NOT_LAUNCHED));
        g.verify();

        // the buys may spend what was approved and no more: the wallet's balance is not the approval
        vm.setEnv("V2_MAX_BUY_ETH", "1");
        vm.expectRevert(bytes("genesis v2: V2_MAX_BUY_ETH must cover the listing buys and the first buy"));
        g.plan();
        vm.setEnv("V2_MAX_BUY_ETH", "2000000000000000"); // 0.002 ETH: the listing buys fit, the first buy does not
        vm.expectRevert(bytes(OVER_BUDGET));
        g.launch();
        vm.setEnv("V2_MAX_BUY_ETH", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));

        uint256 clean = vm.snapshotState();
        uint256 ethBuy = _straight();
        vm.revertToState(clean);
        vm.writeFile(_recordPath(), live);
        _competitorBetween(ethBuy);

        vm.removeFile(_recordPath());
    }

    /// @dev The straight run, stage by stage, then the airdrop. Returns what the first buy was sized at.
    function _straight() internal returns (uint256 ethBuy) {
        address me = pl.me;
        (, ethBuy) = g.launch();
        Factory factory = Factory(payable(live.readAddress(".factory")));
        assertEq(factory.creatorFeeRecipientOf(pl.coin), pl.treasury, "the treasury is the creator-fee recipient");
        assertEq(factory.getLaunchedToken(pl.coin).creatorTaxBps, 0, "no creator tax on the v2 path");
        assertEq(factory.getLaunchedToken(pl.coin).deployer, me, "the launching wallet is the recorded deployer");
        assertEq(MarketTickerDeployer(live.readAddress(".marketTickerDeployer")).market(pl.name).token, pl.name, "the name is a v2 market");
        assertGe(IERC20(pl.coin).balanceOf(me), pl.target, "the first buy reached the share");
        assertFalse(vm.keyExistsJson(vm.readFile(_recordPath()), ".genesisV2Token"), "sending marks nothing in the record");

        // still the launch block: anyone else's buy through the router is refused outright
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        (bytes memory commands, bytes[] memory inputs) = UniversalRouterBuy.encode(stranger, _route(3), 0.01 ether, 1);
        vm.prank(stranger);
        vm.expectRevert();
        IUniversalRouter(live.readAddress(".universalRouter")).execute{value: 0.01 ether}(commands, inputs, block.timestamp + 60);

        // every stage refuses out of order
        vm.expectRevert(bytes("genesis v2: the name already exists, so the launch has run: go on from the next stage"));
        g.launch();
        vm.expectRevert(bytes("genesis v2: the first buy is already in"));
        g.buy();
        vm.expectRevert(bytes("genesis v2: the name's listing buy comes first"));
        g.listCoin();
        vm.expectRevert(bytes("genesis v2: the listing buys come before the split"));
        g.split();

        // the ceiling covers every buy, the listing ones included: at the ceiling there is nothing left for them
        vm.setEnv("V2_BUY_SPENT_WEI", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));
        vm.expectRevert(bytes(OVER_BUDGET));
        g.listName();
        vm.setEnv("V2_BUY_SPENT_WEI", "0");

        g.listName();
        assertGt(IERC20(pl.name).balanceOf(me), 0, "the name's listing buy landed in the wallet");
        vm.expectRevert(bytes("genesis v2: the name's listing buy is already in"));
        g.listName();
        vm.expectRevert(bytes("genesis v2: the name's listing buy is in, so the first buy cannot be missing"));
        g.buy();
        vm.roll(block.number + 1);
        vm.setEnv("V2_BUY_SPENT_WEI", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));
        vm.expectRevert(bytes(OVER_BUDGET));
        g.listCoin();
        vm.setEnv("V2_BUY_SPENT_WEI", "0");
        g.listCoin();

        // nothing is recorded before the split has left exactly the airdrop
        vm.expectRevert(bytes("genesis v2: the wallet does not hold exactly the airdrop"));
        g.verify();
        assertFalse(vm.keyExistsJson(vm.readFile(_recordPath()), ".genesisV2Token"), "a failed verify writes nothing");

        _splitAndVerify();
        _airdrop();
    }

    /// @dev A competitor between the launch and the first buy. The launch goes out alone, a claim-settling buyer takes
    /// a large bite in the same block, the first buy as it was sized now misses its minimum and reverts, and `buy()`
    /// sizes the rest from the chain as it is. The competitor later hands the wallet coins nobody asked for; the split
    /// burns them with the rest of the surplus, and the airdrop is still exact.
    function _competitorBetween(uint256 ethBuy) internal {
        address me = pl.me;
        (address to, uint256 value, bytes memory data) = g.launchCall();
        vm.deal(me, 20 ether);
        vm.prank(me, me);
        (bool ok,) = to.call{value: value}(data);
        assertTrue(ok, "the launch, sent alone");

        ClaimBuyer rival = new ClaimBuyer(IPoolManager(live.readAddress(".poolManager")));
        vm.deal(address(rival), 10 ether);
        uint256 claims = rival.buy{value: ethBuy}(_route(3));
        assertGt(claims, 0, "the rival bought in the launch block");
        assertEq(IERC20(pl.coin).balanceOf(address(rival)), 0, "as claims: no coin left the pool manager");

        // the first buy as sized before the rival: its minimum holds, so it reverts instead of taking less
        (bytes memory commands, bytes[] memory inputs) = UniversalRouterBuy.encode(me, _route(3), ethBuy, pl.target);
        IUniversalRouter router = IUniversalRouter(live.readAddress(".universalRouter"));
        vm.prank(me, me);
        vm.expectRevert();
        router.execute{value: ethBuy}(commands, inputs, block.timestamp + 60);
        assertEq(IERC20(pl.coin).balanceOf(me), 0, "nothing bought");

        // the recovery stage buys what is missing, at today's price
        vm.expectRevert(bytes("genesis v2: the first buy is not in: run buy()"));
        g.listName();
        // dearer after the rival, so the ceiling the first buy was approved under stops it: raising it is a decision
        vm.setEnv("V2_MAX_BUY_ETH", vm.toString(ethBuy));
        vm.expectRevert(bytes(OVER_BUDGET));
        g.buy();
        vm.setEnv("V2_MAX_BUY_ETH", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));
        // and what earlier buys already spent counts against the same ceiling
        vm.setEnv("V2_BUY_SPENT_WEI", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));
        vm.expectRevert(bytes(OVER_BUDGET));
        g.buy();
        vm.setEnv("V2_BUY_SPENT_WEI", "0");
        uint256 again = g.buy();
        assertGt(again, ethBuy, "dearer after the rival");
        assertGe(IERC20(pl.coin).balanceOf(me), pl.target, "the share is in");
        vm.expectRevert(bytes("genesis v2: the first buy is already in"));
        g.buy();

        g.listName();
        vm.roll(block.number + 1);
        g.listCoin();

        // coins nobody asked for, straight out of the pool manager into the (exempt) wallet
        uint256 gift = claims / 10;
        rival.redeem(Currency.wrap(pl.coin), me, gift);
        uint256 held = IERC20(pl.coin).balanceOf(me);
        uint256 deadBefore = IERC20(pl.coin).balanceOf(DEAD);
        (, uint256 burned) = g.split();
        assertEq(burned, held - pl.target - vm.envUint("V2_EXTRA_KEPT"), "everything past the share except what was kept out of it, the gift included");
        assertEq(IERC20(pl.coin).balanceOf(DEAD) - deadBefore, burned, "burned exactly that");
        assertEq(IERC20(pl.coin).balanceOf(me), pl.kept, "the wallet holds exactly the airdrop");
        assertEq(IERC20(pl.coin).balanceOf(pl.treasury), pl.toTreasury, "the treasury holds exactly its share");
        g.verify();
        assertEq(vm.readFile(_recordPath()).readAddress(".genesisV2Token"), pl.coin, "recorded once the chain checks");
    }

    function _splitAndVerify() internal {
        address me = pl.me;
        uint256 held = IERC20(pl.coin).balanceOf(me);
        uint256 deadBefore = IERC20(pl.coin).balanceOf(DEAD);
        (uint256 toTreasury, uint256 burned) = g.split();
        assertEq(toTreasury, pl.toTreasury, "the treasury's whole share");
        assertEq(toTreasury, (IERC20(pl.coin).totalSupply() * vm.envUint("V2_TREASURY_BPS")) / 10_000, "exactly the disclosed share, nothing taken off it");
        assertEq(IERC20(pl.coin).balanceOf(pl.treasury), pl.toTreasury, "the treasury holds exactly its share");
        assertEq(IERC20(pl.coin).balanceOf(me), pl.kept, "the wallet holds exactly the airdrop");
        assertEq(pl.kept, pl.target - pl.toTreasury + vm.envUint("V2_EXTRA_KEPT"), "kept is the airdrop plus what came out of the surplus");
        assertGt(burned, 0, "the margin and the listing buy bought past the share");
        assertEq(burned, held - pl.target - vm.envUint("V2_EXTRA_KEPT"), "everything past the share except what was kept out of it");
        assertEq(IERC20(pl.coin).balanceOf(DEAD) - deadBefore, burned, "and exactly that went to the dead address");
        _allowancesSpent();
        vm.expectRevert(bytes("genesis v2: the wallet holds less than the first buy: split already, or the buy is missing"));
        g.split();

        (, bytes32 poolId) = g.verify();
        string memory rec = vm.readFile(_recordPath());
        assertEq(rec.readAddress(".genesisV2Token"), pl.coin, "the coin, recorded");
        assertEq(rec.readAddress(".genesisV2Name"), pl.name, "its name, recorded");
        assertEq(rec.readBytes32(".genesisV2Pool"), poolId, "its pool, recorded");
        assertEq(poolId, Factory(payable(live.readAddress(".factory"))).poolIdOf(pl.coin), "the pool is the coin's");
        g.verify(); // a second verify finds it recorded and changes nothing
        vm.expectRevert(bytes("genesis v2: the record already has a v2 genesis coin"));
        g.launch();
    }

    function _airdrop() internal {
        address me = pl.me;
        string memory listPath = _list(pl.kept);
        vm.setEnv("AIRDROP_FILE", listPath);
        vm.setEnv("AIRDROP_SHA256", vm.toString(sha256(bytes(vm.readFile(listPath)))));
        vm.setEnv("AIRDROP_TOKEN", vm.toString(pl.coin));

        AirdropV2 a = new AirdropV2();
        vm.expectRevert(bytes("airdrop: the coin's launch protection has not ended"));
        a.run();
        vm.roll(Token(pl.coin).protectionEndsAtBlock());

        // a list that is not the published one, by a byte
        vm.setEnv("AIRDROP_SHA256", vm.toString(sha256(abi.encodePacked(vm.readFile(listPath), " "))));
        vm.expectRevert(bytes("airdrop: the list is not the published one (its SHA-256 differs)"));
        a.run();
        vm.setEnv("AIRDROP_SHA256", vm.toString(sha256(bytes(vm.readFile(listPath)))));

        // a list whose total is not what the wallet holds
        string memory short = _write("genesis-v2-test-short.json", makeAddr("r1"), pl.kept - 1);
        _expectListRefused(short, "airdrop: the wallet does not hold exactly the list's total");

        // Permit2's batch is all or nothing: one payment the wallet cannot cover and the ones before it are undone
        {
            IAllowanceTransfer permit2 = IAllowanceTransfer(live.readAddress(".permit2"));
            IAllowanceTransfer.AllowanceTransferDetails[] memory d = new IAllowanceTransfer.AllowanceTransferDetails[](2);
            d[0] = IAllowanceTransfer.AllowanceTransferDetails({from: me, to: makeAddr("first"), amount: 1, token: pl.coin});
            d[1] = IAllowanceTransfer.AllowanceTransferDetails({from: me, to: makeAddr("second"), amount: uint160(pl.kept), token: pl.coin});
            vm.startPrank(me, me);
            IERC20(pl.coin).approve(address(permit2), pl.kept + 1);
            permit2.approve(pl.coin, me, uint160(pl.kept + 1), uint48(block.timestamp + 60));
            vm.expectRevert();
            permit2.transferFrom(d);
            IERC20(pl.coin).approve(address(permit2), 0);
            permit2.approve(pl.coin, me, 0, 0);
            vm.stopPrank();
            assertEq(IERC20(pl.coin).balanceOf(makeAddr("first")), 0, "the first payment was undone with the batch");
        }

        (address[] memory to, uint256[] memory amounts) = _read(listPath);
        vm.setEnv("AIRDROP_FILE", listPath);
        vm.setEnv("AIRDROP_SHA256", vm.toString(sha256(bytes(vm.readFile(listPath)))));
        AirdropV2.Result memory r = a.run();
        assertEq(r.count, to.length, "every recipient");
        assertEq(r.sent, pl.kept, "the whole airdrop was sent");
        assertEq(IERC20(pl.coin).balanceOf(me), 0, "the wallet is empty afterwards");
        for (uint256 i; i < to.length; i++) {
            assertEq(IERC20(pl.coin).balanceOf(to[i]), amounts[i], "each recipient got exactly its amount");
        }
        _allowancesSpent();
        vm.expectRevert(bytes("airdrop: the wallet holds none of the coin: sent already?"));
        a.run();

        // a list with a repeated recipient is refused before anything is sent
        string memory dup = string.concat(vm.projectRoot(), "/deployments/genesis-v2-test-dup.json");
        vm.writeFile(dup, string.concat('{"addresses":["', vm.toString(to[0]), '","', vm.toString(to[0]), '"],"amounts":["1","1"],"total":"2"}'));
        _expectListRefused(dup, "airdrop: a recipient appears twice");
        if (bytes(vm.envOr("TEST_AIRDROP_FILE", string(""))).length == 0) vm.removeFile(listPath);
    }

    function _expectListRefused(string memory path, string memory why) internal {
        vm.setEnv("AIRDROP_FILE", path);
        vm.setEnv("AIRDROP_SHA256", vm.toString(sha256(bytes(vm.readFile(path)))));
        AirdropV2 a = new AirdropV2();
        vm.expectRevert(bytes(why));
        a.run();
        vm.removeFile(path);
    }

    function _allowancesSpent() internal view {
        (uint160 left,,) = IAllowanceTransfer(live.readAddress(".permit2")).allowance(pl.me, pl.coin, pl.me);
        assertEq(left, 0, "no Permit2 allowance left");
        assertEq(IERC20(pl.coin).allowance(pl.me, live.readAddress(".permit2")), 0, "no coin allowance left");
    }

    function _route(uint256 hops) internal view returns (PoolKey[] memory route) {
        route = new PoolKey[](hops);
        route[0] = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(live.readAddress(".usdg")), fee: 100, tickSpacing: 1, hooks: IHooks(address(0))});
        route[1] = MarketTickerDeployer(live.readAddress(".marketTickerDeployer")).keyFor(pl.name);
        if (hops == 3) route[2] = Factory(payable(live.readAddress(".factory"))).poolKeyOf(pl.coin);
    }

    function _setEnv() internal {
        vm.setEnv("EXPECTED_CHAIN", vm.toString(block.chainid));
        vm.setEnv("PRIVATE_KEY", vm.toString(PK));
        vm.setEnv("TREASURY", vm.toString(makeAddr("genesis v2 treasury")));
        vm.setEnv("V2_SEED", vm.toString(keccak256("genesis v2 fork test")));
        vm.setEnv("V2_NAME_SYMBOL", "GVTWON");
        vm.setEnv("V2_COIN_NAME", "genesis v2 test");
        vm.setEnv("V2_COIN_SYMBOL", "GVTWOC");
        vm.setEnv("V2_BUY_BPS", vm.toString(vm.envOr("TEST_V2_BUY_BPS", uint256(600))));
        vm.setEnv("V2_TREASURY_BPS", vm.toString(vm.envOr("TEST_V2_TREASURY_BPS", uint256(150))));
        vm.setEnv("V2_EXTRA_KEPT", vm.toString(vm.envOr("TEST_V2_EXTRA_KEPT", uint256(123_456e18))));
        vm.setEnv("V2_MAX_BUY_ETH", vm.toString(vm.envOr("TEST_V2_MAX_BUY_ETH", uint256(1 ether))));
        vm.deal(vm.addr(PK), 5 ether);
    }

    function _recordPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", RECORD);
    }

    /// @dev The real list when one is given, otherwise three recipients splitting `total` unevenly. Written in the
    /// same format as the real one, amounts as decimal strings, so the reader is tested on what it will be given.
    function _list(uint256 total) internal returns (string memory path) {
        path = vm.envOr("TEST_AIRDROP_FILE", string(""));
        if (bytes(path).length != 0) {
            assertEq(vm.readFile(path).readUint(".total"), total, "the real list's total must equal what the genesis kept");
            return path;
        }
        path = string.concat(vm.projectRoot(), "/deployments/genesis-v2-test-airdrop.json");
        uint256 a1 = total / 2;
        uint256 a2 = total / 3;
        uint256 a3 = total - a1 - a2;
        vm.writeFile(
            path,
            string.concat(
                '{"addresses":["', vm.toString(makeAddr("r1")), '","', vm.toString(makeAddr("r2")), '","', vm.toString(makeAddr("r3")),
                '"],"amounts":["', vm.toString(a1), '","', vm.toString(a2), '","', vm.toString(a3), '"],"total":"', vm.toString(total), '"}'
            )
        );
    }

    function _write(string memory file, address to, uint256 total) internal returns (string memory path) {
        path = string.concat(vm.projectRoot(), "/deployments/", file);
        vm.writeFile(path, string.concat('{"addresses":["', vm.toString(to), '"],"amounts":["', vm.toString(total), '"],"total":"', vm.toString(total), '"}'));
    }

    function _read(string memory path) internal view returns (address[] memory to, uint256[] memory amounts) {
        string memory j = vm.readFile(path);
        to = j.readAddressArray(".addresses");
        amounts = j.readUintArray(".amounts");
    }
}
