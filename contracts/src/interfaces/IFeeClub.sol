// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The ticker club. Every coin priced in an invented ticker pays a fixed slice of its trade fee into a
/// pot for that ticker, and the pot is shared by the creators of the *other* graduated coins under the same
/// ticker, pro rata to their pool volume over the same thirty days. Implemented by `TickerLauncher`.
interface IFeeClub {
    /// @notice Whether `pairToken` carries a club: true for every invented ticker, false for everything else.
    function hasClub(address pairToken) external view returns (bool);

    /// @notice Books `amount` of `token`'s quote asset, already transferred to the club, as `token`'s club fee
    /// for the current epoch. Only a curve or the hook may call.
    function onClubFee(address token, uint256 amount) external;

    /// @notice Records `quoteAmount` of pool volume for `token` in the current epoch. Only the hook may call.
    function recordVolume(address token, uint256 quoteAmount) external;
}
