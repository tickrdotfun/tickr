// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {TokenParams, PairEconomics, LaunchConfig} from "../Types.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";
import {FeeSettings} from "./FeeSettings.sol";

/// @title MarketTickerLauncher
/// @notice Launch a coin priced in a fixed-inventory name: an existing one, or one made in the same transaction.
///
/// This is the reusable path the experiment's `MarketTickerRegistrar` stood in for. That one fixed its wallet,
/// its name and its single launch at construction because it was a one-off with registrar powers on the factory;
/// this one is open to anyone, so what kept that one safe has to come from checks instead.
///
/// Three of them, and none is optional:
///
/// 1. The name must have been made by the market issuer this launcher was built with. Anything else is refused,
///    so registrar powers cannot be borrowed to open a pool against an arbitrary token.
/// 2. The coin's economics are not the caller's to choose. They are read live from the factory, as the dollar's
///    own, exactly as the managed launcher reads them, because a name's market opens at parity with a dollar.
///    A caller who could set them could open a coin at any price it liked.
/// 3. The coin must sort below the name, so it is currency0 of its own pool. `TickerLauncher` enforces this for
///    its launches; this path goes straight to the factory and so must enforce it itself. The caller grinds
///    `params.salt` until the predicted address sorts under the name. It cannot live in the factory: a coin
///    paired with native ETH can never satisfy it, because address zero always sorts first.
/// 4. The name must carry the counter's own decimals. A market opens at parity in raw units, and the economics
///    handed to the factory are the counter's, denominated in the counter's decimals. Those two only describe
///    the same thing while the decimals match: a name with fewer makes every name worth less than the dollar the
///    economics assume, and a name with more makes it worth more, silently. Supporting a difference is not
///    another argument to accept, it is a scaled price and a scaled supply throughout, so until that exists the
///    mismatch is refused rather than opened at a wrong price.
contract MarketTickerLauncher {
    IFactory public immutable factory;
    MarketTickerDeployer public immutable deployer;
    /// @notice The counter asset the names are priced in, and whose economics a coin under one launches on.
    IERC20Metadata public immutable counter;

    event MarketLaunch(address indexed token, address indexed name, address indexed creator, bool nameIsNew);

    error UnknownMarket(address name);
    error NotTheCounter(address counter);
    /// @dev The name does not carry the counter's decimals, so parity in raw units is not parity in value.
    error DecimalsMismatch(address name, uint8 nameDecimals, uint8 counterDecimals);
    /// @dev The same guarantee `TickerLauncher` gives its own launches.
    error CoinNotFirst(address coin, address name);
    /// @notice The launch would not cost 82 bps. Raised when the chosen configuration's base fee is not the
    /// frozen one, or when a creator surcharge would be added on top of it. Both would make the pool charge
    /// something other than what this path promises.
    error NotTheFrozenFee(uint256 baseFeeBps, uint16 creatorTaxBps);

    constructor(IFactory factory_, MarketTickerDeployer deployer_) {
        require(address(factory_) != address(0) && address(deployer_) != address(0), "MarketTickerLauncher: zero");
        factory = factory_;
        deployer = deployer_;
        counter = IERC20Metadata(address(deployer_.counter()));
    }

    /// @notice The decimals every name here must carry, which is the counter's own.
    function requiredDecimals() public view returns (uint8) {
        return counter.decimals();
    }

    /// @notice Launch a coin against a name that already exists.
    ///
    /// The name's decimals are checked here as well as at creation. A market made before this rule existed, or
    /// by an issuer configured differently, is refused rather than launched against at a price that is wrong by
    /// a power of ten.
    function launch(TokenParams calldata params, uint256 launchConfigId, address name)
        external
        payable
        returns (address token, bytes32 poolId)
    {
        _requireOurs(name);
        _requireDecimals(name);
        (token, poolId) = _launch(params, launchConfigId, name);
        emit MarketLaunch(token, name, msg.sender, false);
    }

    /// @notice Make a name and launch a coin against it, in one transaction.
    ///
    /// Both addresses are settled before either exists: the name from `salt`, the coin from `params.salt`, so a
    /// caller can grind the coin under the name and know the ordering check will pass before paying anything.
    function createAndLaunch(
        bytes32 nameSalt,
        string calldata symbol,
        uint8 decimals,
        TokenParams calldata params,
        uint256 launchConfigId
    ) external payable returns (address name, address token, bytes32 poolId) {
        uint8 want = requiredDecimals();
        if (decimals != want) revert DecimalsMismatch(address(0), decimals, want);
        (name,) = deployer.create(nameSalt, symbol, decimals);
        (token, poolId) = _launch(params, launchConfigId, name);
        emit MarketLaunch(token, name, msg.sender, true);
    }

    /// @notice Where a name made here will land, so a caller can grind a coin under it beforehand. It refuses
    /// the decimals the launch itself would refuse, so a caller cannot grind against an address that can never
    /// be launched under.
    function predictName(bytes32 salt, string calldata symbol, uint8 decimals) external view returns (address) {
        uint8 want = requiredDecimals();
        if (decimals != want) revert DecimalsMismatch(address(0), decimals, want);
        return deployer.predict(salt, symbol, decimals);
    }

    /// @notice The economics a coin under any of these names opens on. Not a parameter, so a caller can only
    /// read them, and a front end can quote a launch with the same figures the launch will use.
    function economics() public view returns (PairEconomics memory e) {
        (uint256 phantom,) = factory.pairTokenEconomics(address(counter));
        e = PairEconomics({phantomQuote: phantom, decimals: counter.decimals()});
    }

    /// @notice What the factory will check the launch against, for a front end that previews before it sends.
    function previewEconomics(uint256 launchConfigId, address name) external view returns (bytes32) {
        return factory.previewLaunchEconomicsWithPair(launchConfigId, name, economics());
    }

    function _requireOurs(address name) internal view {
        if (deployer.market(name).token != name) revert UnknownMarket(name);
    }

    /// @dev A name that cannot say what its decimals are is refused too: an answer is required, not assumed.
    function _requireDecimals(address name) internal view {
        uint8 want = requiredDecimals();
        try IERC20Metadata(name).decimals() returns (uint8 got) {
            if (got != want) revert DecimalsMismatch(name, got, want);
        } catch {
            revert DecimalsMismatch(name, type(uint8).max, want);
        }
    }

    /// @dev Every launch on this path costs exactly the frozen fee, and the contract is what makes that true.
    ///
    /// The factory authorises a registrar, not a configuration: an authorised launcher may name ANY enabled
    /// configuration id, including the older 100 bps one, and may add a creator surcharge on top. So a promise
    /// of "82 bps" cannot rest on which configuration the owner happened to enable. It is enforced here, on
    /// both halves of the pool fee, or it is not a promise at all.
    function _launch(TokenParams calldata params, uint256 launchConfigId, address name)
        internal
        returns (address token, bytes32 poolId)
    {
        LaunchConfig memory c = factory.getLaunchConfig(launchConfigId);
        if (c.baseFeeBps != FeeSettings.BASE_FEE_BPS || params.creatorTaxBps != FeeSettings.CREATOR_TAX_BPS) {
            revert NotTheFrozenFee(c.baseFeeBps, params.creatorTaxBps);
        }
        (token, poolId) =
            factory.launchTokenWithPair{value: msg.value}(msg.sender, params, launchConfigId, name, economics());
        if (token >= name) revert CoinNotFirst(token, name);
    }
}
