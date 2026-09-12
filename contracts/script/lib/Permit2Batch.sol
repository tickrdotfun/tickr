// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/// @title Permit2Batch
/// @notice Pays a list of wallets from one wallet in a single transaction, through Uniswap's canonical Permit2, so a
/// distribution lands whole or not at all. No contract of ours is involved and nothing new is deployed.
///
/// Three transactions from the paying wallet, inside the caller's broadcast:
///   1. the coin's `approve(permit2, total)`: exactly the total, never more;
///   2. `permit2.approve(coin, wallet, total, now + 1 hour)`: the wallet allows itself, exactly the total, briefly;
///   3. `permit2.transferFrom(details)`: every payment, `from` the wallet, in one call. Permit2 spends its own
///      allowance and the coin's, entry by entry; any entry that fails reverts the whole call.
/// Only the third moves coins, so an interruption before it leaves every balance where it was, and running the three
/// again is harmless: both approvals set an absolute amount. Afterwards both allowances are spent down to zero,
/// which `spent` checks.
library Permit2Batch {
    /// @dev Room for the batch to land after the approval. Permit2 refuses the transfer once this has passed.
    uint48 internal constant WINDOW = 1 hours;

    function send(IAllowanceTransfer permit2, address coin, address wallet, address[] memory to, uint256[] memory amounts)
        internal
        returns (uint256 total)
    {
        require(to.length > 0 && to.length == amounts.length, "batch: the list is empty or its columns differ in length");
        IAllowanceTransfer.AllowanceTransferDetails[] memory d = new IAllowanceTransfer.AllowanceTransferDetails[](to.length);
        for (uint256 i; i < to.length; i++) {
            require(amounts[i] > 0 && amounts[i] <= type(uint160).max, "batch: an amount is zero or too large");
            d[i] = IAllowanceTransfer.AllowanceTransferDetails({from: wallet, to: to[i], amount: uint160(amounts[i]), token: coin});
            total += amounts[i];
        }
        require(total <= type(uint160).max, "batch: the total is too large");
        require(IERC20(coin).approve(address(permit2), total), "batch: the coin refused the approval");
        permit2.approve(coin, wallet, uint160(total), uint48(block.timestamp) + WINDOW);
        permit2.transferFrom(d);
    }

    /// @dev Whether both allowances the batch used are back at zero: nothing left for anyone to spend.
    function spent(IAllowanceTransfer permit2, address coin, address wallet) internal view returns (bool) {
        (uint160 left,,) = permit2.allowance(wallet, coin, wallet);
        return left == 0 && IERC20(coin).allowance(wallet, address(permit2)) == 0;
    }
}
