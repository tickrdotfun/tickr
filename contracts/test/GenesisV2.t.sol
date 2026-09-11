// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Fork} from "./Fork.sol";
import {GenesisV2} from "../script/GenesisV2.s.sol";
import {AirdropV2} from "../script/AirdropV2.s.sol";
import {Factory} from "../src/Factory.sol";
import {Token} from "../src/Token.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {UniversalRouterBuy, IUniversalRouter} from "../script/lib/UniversalRouterBuy.sol";

/// @notice `GenesisV2.s.sol` and `AirdropV2.s.sol`, run as written against live mainnet state: the real factory, the
/// real v2 launcher, the real ETH/USDG pool and the canonical Universal Router.
///
/// One test, run in order, on purpose. Both scripts read their inputs from the environment, the environment belongs
/// to the whole process, and forge runs tests in parallel: several tests setting different values would read each
/// other's. So the refusals are checked inside the same run, each with its value put back afterwards.
///
/// The shares default to values that are not the planned ones, so this file says nothing about a coming launch;
/// `TEST_V2_BUY_BPS` and `TEST_V2_TREASURY_BPS` set others. `TEST_AIRDROP_FILE` runs the airdrop from a real list,
/// whose total must then equal what the genesis kept. Without `FORK_RPC` the test does nothing, like every fork suite.
contract GenesisV2ForkTest is Test {
    using stdJson for string;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant PK = 0xA11CE;

    function test_fork_genesisV2_launchBuySplitThenAirdrop() public {
        if (!Fork.select()) return;
        address me = vm.addr(PK);
        address treasury = makeAddr("genesis v2 treasury");
        uint256 buyBps = vm.envOr("TEST_V2_BUY_BPS", uint256(600));
        uint256 treasuryBps = vm.envOr("TEST_V2_TREASURY_BPS", uint256(150));
        uint256 holdback = vm.envOr("TEST_V2_HOLDBACK", uint256(123_456e18));
        vm.deal(me, 5 ether);
        _setEnv(me, treasury, buyBps, treasuryBps);
        vm.setEnv("V2_TREASURY_HOLDBACK", vm.toString(holdback));

        // a run meant for another chain stops before anything else
        GenesisV2 wrongChain = new GenesisV2();
        vm.setEnv("EXPECTED_CHAIN", "1");
        vm.expectRevert(bytes("genesis v2: wrong chain"));
        wrongChain.run();
        vm.setEnv("EXPECTED_CHAIN", vm.toString(block.chainid));

        // the genesis itself
        GenesisV2.Result memory r = new GenesisV2().run();
        string memory rec = vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        Factory factory = Factory(payable(rec.readAddress(".factory")));
        uint256 supply = IERC20(r.coin).totalSupply();

        // where it landed
        assertEq(uint16(uint160(r.coin)), 0x6942, "the coin ends in 6942");
        assertLt(uint160(r.coin), uint160(r.name), "the coin sorts below its name");
        assertEq(uint160(r.name) >> 156, 0xF, "the name was ground high");
        assertEq(MarketTickerDeployer(rec.readAddress(".marketTickerDeployer")).market(r.name).token, r.name, "the name is a v2 market");

        // what it launched on
        assertEq(factory.creatorFeeRecipientOf(r.coin), treasury, "the treasury is the creator-fee recipient");
        assertEq(factory.getLaunchedToken(r.coin).creatorTaxBps, 0, "no creator tax on the v2 path");
        assertEq(factory.getLaunchedToken(r.coin).deployer, me, "the launching wallet is the recorded deployer");

        // the buy and the split, exactly
        uint256 target = (supply * buyBps) / 10_000;
        assertGe(r.bought, target, "the first buy reached the share");
        assertEq(r.toTreasury, (supply * treasuryBps) / 10_000 - holdback, "the treasury's share, less what is held back for it");
        assertEq(r.kept, target - (supply * treasuryBps) / 10_000 + holdback, "the airdrop plus the holdback stay in the wallet");
        assertEq(IERC20(r.coin).balanceOf(treasury), r.toTreasury, "the treasury holds exactly its share");
        assertEq(IERC20(r.coin).balanceOf(me), target - r.toTreasury, "the wallet holds exactly the airdrop");
        assertEq(r.kept, target - r.toTreasury, "kept is the airdrop");
        assertGt(r.burned, 0, "the margin and the listing buy bought past the share");
        assertEq(IERC20(r.coin).balanceOf(DEAD), r.burned, "everything past the share went to the dead address");
        assertEq(r.toTreasury + r.kept + r.burned, IERC20(r.coin).balanceOf(treasury) + IERC20(r.coin).balanceOf(me) + IERC20(r.coin).balanceOf(DEAD), "every coin bought is accounted for");
        assertGt(IERC20(r.name).balanceOf(me), 0, "the name's listing buy landed in the wallet");

        // still the launch block: anyone else's buy is refused outright
        {
            address stranger = makeAddr("stranger");
            vm.deal(stranger, 1 ether);
            PoolKey[] memory route = new PoolKey[](3);
            route[0] = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(rec.readAddress(".usdg")), fee: 100, tickSpacing: 1, hooks: IHooks(address(0))});
            route[1] = MarketTickerDeployer(rec.readAddress(".marketTickerDeployer")).keyFor(r.name);
            route[2] = factory.poolKeyOf(r.coin);
            IUniversalRouter router = IUniversalRouter(rec.readAddress(".universalRouter"));
            (bytes memory commands, bytes[] memory inputs) = UniversalRouterBuy.encode(stranger, route, 0.01 ether, 1);
            vm.prank(stranger);
            vm.expectRevert();
            router.execute{value: 0.01 ether}(commands, inputs, block.timestamp + 60);
        }

        // the airdrop refuses while launch protection lasts
        string memory listPath = _list(r.kept);
        vm.setEnv("AIRDROP_FILE", listPath);
        vm.setEnv("AIRDROP_TOKEN", vm.toString(r.coin));
        AirdropV2 early = new AirdropV2();
        vm.expectRevert(bytes("airdrop: the coin's launch protection has not ended"));
        early.run();

        // and sends once it has ended
        vm.roll(Token(r.coin).protectionEndsAtBlock());
        (address[] memory to, uint256[] memory amounts) = _read(listPath);
        AirdropV2.Result memory a = new AirdropV2().run();
        assertEq(a.count, to.length, "one transfer per recipient");
        assertEq(a.sent, r.kept, "the whole airdrop was sent");
        assertEq(IERC20(r.coin).balanceOf(me), 0, "the wallet is empty afterwards");
        for (uint256 i; i < to.length; i++) {
            assertEq(IERC20(r.coin).balanceOf(to[i]), amounts[i], "each recipient got exactly its amount");
        }

        // a list with a repeated recipient is refused before anything is sent
        string memory dup = string.concat(vm.projectRoot(), "/deployments/genesis-v2-test-dup.json");
        vm.writeFile(dup, string.concat('{"addresses":["', vm.toString(to[0]), '","', vm.toString(to[0]), '"],"amounts":["1","1"],"total":"2"}'));
        vm.setEnv("AIRDROP_FILE", dup);
        AirdropV2 twice = new AirdropV2();
        vm.expectRevert(bytes("airdrop: a recipient appears twice"));
        twice.run();
        vm.removeFile(dup);
        if (bytes(vm.envOr("TEST_AIRDROP_FILE", string(""))).length == 0) vm.removeFile(listPath);
    }

    function _setEnv(address, address treasury, uint256 buyBps, uint256 treasuryBps) internal {
        vm.setEnv("EXPECTED_CHAIN", vm.toString(block.chainid));
        vm.setEnv("PRIVATE_KEY", vm.toString(PK));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("V2_SEED", vm.toString(keccak256("genesis v2 fork test")));
        vm.setEnv("V2_NAME_SYMBOL", "GVTWON");
        vm.setEnv("V2_COIN_NAME", "genesis v2 test");
        vm.setEnv("V2_COIN_SYMBOL", "GVTWOC");
        vm.setEnv("V2_BUY_BPS", vm.toString(buyBps));
        vm.setEnv("V2_TREASURY_BPS", vm.toString(treasuryBps));
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

    function _read(string memory path) internal view returns (address[] memory to, uint256[] memory amounts) {
        string memory j = vm.readFile(path);
        to = j.readAddressArray(".addresses");
        amounts = j.readUintArray(".amounts");
    }
}
