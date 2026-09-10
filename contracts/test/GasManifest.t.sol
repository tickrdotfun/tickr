// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {TokenParams, Socials, LaunchConfig} from "../src/Types.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

/// @dev Every transaction the acceptance run would send, measured rather than guessed.
///
/// Execution gas only. A wallet also pays the intrinsic 21,000 and its calldata, which the manifest adds on top
/// per transaction; that is stated there rather than folded in here, so the two are not confused.
contract GasManifestForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address deployWallet = address(0xDEA1);
    address owner;
    bool forked;

    function setUp() public {
        forked = Fork.select();
        if (forked) owner = IFactory(FACTORY).owner();
    }

    function _params(string memory sym, bytes32 expected) internal pure returns (TokenParams memory p) {
        p = TokenParams({
            name: sym, symbol: sym, logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0),
            creatorTaxBps: FeeSettings.CREATOR_TAX_BPS, buybackEnabled: false, expectedEconomics: expected, salt: bytes32(0)
        });
    }

    MarketTickerDeployer issuer;
    MarketTickerLauncher launcher;
    uint256 configId;
    uint256 gasIssuer;
    uint256 gasLauncher;
    uint256 gasConfig;
    uint256 gasGrant;

    /// @notice Each transaction of the run, in order, with its execution gas.
    function test_fork_theGasEveryStepCosts() public {
        if (!forked) return;
        _deployAndConfigure();
        _launchBoth();
    }

    function _deployAndConfigure() internal {
        vm.deal(deployWallet, 10 ether);
        vm.fee(1 gwei);
        console.log("base fee, wei");
        console.log(block.basefee);

        // 1 and 2: the two deployments, from the deploy wallet, with the issuer naming the launcher by nonce
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        vm.startPrank(deployWallet, deployWallet);
        address predictedLauncher = vm.computeCreateAddress(deployWallet, vm.getNonce(deployWallet) + 1);
        uint256 g = gasleft();
        issuer = new MarketTickerDeployer(
            predictedLauncher, IERC20(USDG), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            live.supply(), live.fee(), live.spacing(), live.width()
        );
        gasIssuer = g - gasleft();
        g = gasleft();
        launcher = new MarketTickerLauncher(IFactory(FACTORY), issuer);
        gasLauncher = g - gasleft();
        vm.stopPrank();
        assertEq(address(launcher), predictedLauncher, "the issuer names the launcher that owns it");

        // Deployment gas is NOT taken from these figures. A CREATE inside a test does not account for the code
        // deposit the way a real transaction does, and the numbers that come out are far too small to be a
        // deployment. The manifest bounds them from the compiled bytecode instead, and says so.
        console.log("deployment gas measured in-test, NOT USED: issuer | launcher");
        console.log(gasIssuer);
        console.log(gasLauncher);
        console.log("deployed code size, bytes: issuer | launcher");
        console.log(address(issuer).code.length);
        console.log(address(launcher).code.length);

        // 3: add the configuration. Its id is read from the return value, never assumed
        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        LaunchConfig memory c = LaunchConfig({
            supply: base.supply, baseFeeBps: FeeSettings.BASE_FEE_BPS,
            phantomQuote: base.phantomQuote, tickSpacing: base.tickSpacing, enabled: true
        });
        vm.startPrank(owner, owner);
        vm.recordLogs();
        g = gasleft();
        (bool ok1,) = FACTORY.call(abi.encodeWithSignature("addLaunchConfig((uint256,uint256,uint256,int24,bool))", c));
        gasConfig = g - gasleft();
        require(ok1, "addLaunchConfig");
        // the id comes from the event on the confirmed transaction, which is what a real run can read. A return
        // value is not available from a mined transaction, and the count is a race against anyone else adding one
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == FACTORY && logs[i].topics[0] == keccak256("LaunchConfigAdded(uint256)")) {
                configId = uint256(logs[i].topics[1]);
                found = true;
            }
        }
        require(found, "no LaunchConfigAdded");

        // 4: the registrar grant
        g = gasleft();
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), true));
        gasGrant = g - gasleft();
        require(ok2, "grant");
        vm.stopPrank();

        console.log("3 addLaunchConfig gas | the id it actually returned | 4 setRegistrar true gas");
        console.log(gasConfig);
        console.log(configId);
        console.log(gasGrant);
        // and then verified, which is what the manifest says to do before the id is used for anything
        LaunchConfig memory got = IFactory(FACTORY).getLaunchConfig(configId);
        assertEq(got.baseFeeBps, FeeSettings.BASE_FEE_BPS, "the id points at the configuration we added");
        assertTrue(got.enabled, "and it is enabled");
        assertEq(got.supply, base.supply, "with the supply copied from config 0");

    }

    function _launchBoth() internal {
        LaunchConfig memory c = IFactory(FACTORY).getLaunchConfig(configId);
        // 5: createAndLaunch, the fresh name and coin A
        address creator = address(0xC0FFEE);
        vm.deal(creator, 10 ether);
        bytes32 nameSalt = keccak256("ACCEPTANCE");
        address predictedName = launcher.predictName(nameSalt, "ACCEPT", 6);
        TokenParams memory pa = _params("ACOIN", launcher.previewEconomics(configId, predictedName));
        for (uint256 i = 1; i < 80_000; ++i) {
            pa.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, pa, c.supply) < predictedName) break;
        }
        uint256 fee = IFactory(FACTORY).launchFee();
        vm.startPrank(creator, creator);
        uint256 g = gasleft();
        (address name, address coinA,) = launcher.createAndLaunch{value: fee}(nameSalt, "ACCEPT", 6, pa, configId);
        uint256 gasCreateAndLaunch = g - gasleft();

        // 6: launch, coin B under the same name
        TokenParams memory pb = _params("BCOIN", launcher.previewEconomics(configId, name));
        for (uint256 i = 1; i < 80_000; ++i) {
            pb.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, pb, c.supply) < name) break;
        }
        g = gasleft();
        (address coinB,) = launcher.launch{value: fee}(pb, configId, name);
        uint256 gasLaunch = g - gasleft();
        vm.stopPrank();

        console.log("5 createAndLaunch gas | 6 launch gas");
        console.log(gasCreateAndLaunch);
        console.log(gasLaunch);
        assertTrue(coinA < name && coinB < name, "both coins sort below the name");

        // 7: the revocation, which the owner signs and which the reserve must cover
        vm.startPrank(owner, owner);
        g = gasleft();
        (bool ok3,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), false));
        uint256 gasRevoke = g - gasleft();
        vm.stopPrank();
        require(ok3, "revoke");
        console.log("7 setRegistrar false gas, signed by the owner");
        console.log(gasRevoke);

        // 8: disabling the configuration, which is cleanup and is the owner's too
        LaunchConfig memory off = IFactory(FACTORY).getLaunchConfig(configId);
        off.enabled = false;
        vm.startPrank(owner, owner);
        g = gasleft();
        (bool ok4,) = FACTORY.call(abi.encodeWithSignature("setLaunchConfig(uint256,(uint256,uint256,uint256,int24,bool))", configId, off));
        uint256 gasDisable = g - gasleft();
        vm.stopPrank();
        require(ok4, "disable");
        console.log("8 setLaunchConfig disabled gas");
        console.log(gasDisable);
        assertFalse(IFactory(FACTORY).getLaunchConfig(configId).enabled, "the configuration is off");

        // the totals the manifest quotes
        uint256 ownerGas = gasConfig + gasGrant + gasRevoke + gasDisable;
        uint256 creatorGas = gasCreateAndLaunch + gasLaunch;
        console.log("execution gas by signer: owner, all four calls | creator (deployments bounded separately)");
        console.log(ownerGas);
        console.log(creatorGas);
        assertGt(gasRevoke, 0, "revocation costs something and must be reserved for");
    }
}
