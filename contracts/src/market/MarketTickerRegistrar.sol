// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFactory} from "../interfaces/IFactory.sol";
import {TokenParams, PairEconomics} from "../Types.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";

/// @title MarketTickerRegistrar
/// @notice Launches exactly one coin, against exactly one name, for exactly one wallet, and then refuses
/// everything for ever.
///
/// A coin priced in a fixed-inventory name reaches the factory the same way a coin priced in a managed name
/// does: the registrar path, which approves the pair for that single launch on economics the registrar supplies.
/// It is not `setPairTokenEconomics` plus an anchor registration. A name is not an anchor, the registry's kinds
/// are native, stable and official stock, and no live name is in that registry at all.
///
/// While a registrar is authorised on the factory it can launch coins, so this one is written for a single
/// experiment rather than for use: the wallet, the name and the launch count are all fixed at construction, and
/// the one permitted launch closes it permanently. Its authorisation is still revoked afterwards; this is the
/// belt to that revocation's braces, so a delay or a failure in revoking cannot become an open door.
contract MarketTickerRegistrar {
    IFactory public immutable factory;
    MarketTickerDeployer public immutable deployer;
    /// @notice The only wallet that may launch through this registrar.
    address public immutable testWallet;
    /// @notice The only name it may launch against.
    address public immutable name;
    /// @notice The opening size of the coin's pool, in the name's own units.
    uint256 public immutable phantomQuote;

    /// @notice True once the one permitted launch has succeeded. It never goes back.
    bool public spent;

    error NotTheTestWallet();
    error NotTheName();
    error AlreadyUsed();
    error UnknownMarket();
    /// @dev The same guarantee `TickerLauncher` gives its own launches, which this path bypasses.
    error CoinNotFirst(address coin, address name);

    constructor(IFactory factory_, MarketTickerDeployer deployer_, address testWallet_, address name_, uint256 phantomQuote_) {
        require(testWallet_ != address(0) && name_ != address(0) && phantomQuote_ != 0, "MarketTickerRegistrar: zero");
        factory = factory_;
        deployer = deployer_;
        testWallet = testWallet_;
        name = name_;
        phantomQuote = phantomQuote_;
    }

    /// @notice The one launch. Anyone else, any other name, or a second attempt, is refused.
    function launch(TokenParams calldata params, uint256 launchConfigId, address name_)
        external
        payable
        returns (address token, bytes32 poolId)
    {
        if (spent) revert AlreadyUsed();
        if (msg.sender != testWallet) revert NotTheTestWallet();
        if (name_ != name) revert NotTheName();
        if (deployer.market(name_).token != name_) revert UnknownMarket();
        // closed before the call, so a re-entrant attempt through the factory cannot slip a second launch in
        spent = true;
        (token, poolId) = factory.launchTokenWithPair{value: msg.value}(
            msg.sender, params, launchConfigId, name_, PairEconomics({phantomQuote: phantomQuote, decimals: 6})
        );
        // the coin must be currency0 of its pool and the name currency1, exactly as `TickerLauncher` requires of
        // its own launches. This path goes straight to the factory and so has to make the same check itself; the
        // caller grinds `params.salt` until the address sorts below the name. It belongs here rather than in the
        // factory, because a coin paired with native ETH can never satisfy it: address zero always sorts first.
        if (token >= name_) revert CoinNotFirst(token, name_);
    }
}
