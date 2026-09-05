// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TickerToken
/// @notice A one-for-one wrapper of its counter asset.
///
/// An invented ticker is not a coin. It is a receipt for the counter asset it wraps, one for one, forever:
/// `mint` takes N USDG and issues N BANANA; `redeem` burns N BANANA and returns N USDG. Same decimals, no
/// fee, no owner, no admin function of any kind. The vault can only ever be drawn down by burning the receipt
/// that stands for it, so `totalSupply() <= usdg.balanceOf(this)` holds from the first block to the last.
///
/// Coins are priced in it so that the pair on every chart and explorer is really BREAD/BANANA. A BANANA is
/// worth a USDG because a USDG is exactly what it is redeemable for, and there is nothing to defend because
/// there is no peg, only convertibility.
contract TickerToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable counter;
    uint8 private immutable _decimals;

    event Minted(address indexed by, address indexed to, uint256 amount);
    event Redeemed(address indexed by, address indexed to, uint256 amount);

    error ZeroAmount();

    constructor(string memory name_, string memory symbol_, IERC20 counter_) ERC20(name_, symbol_) {
        counter = counter_;
        _decimals = IERC20Metadata(address(counter_)).decimals();
    }

    /// @notice Same decimals as the counter, so "one for one" is literal down to the last unit.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Deposit `amount` of the counter and receive `amount` of this token, at `to`.
    function mint(uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // credit what arrived, not what was asked: a counter that takes a fee can never leave the wrapper under-backed
        uint256 before = counter.balanceOf(address(this));
        counter.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = counter.balanceOf(address(this)) - before;
        if (got == 0) revert ZeroAmount();
        _mint(to, got);
        emit Minted(msg.sender, to, got);
    }

    /// @notice Burn `amount` of this token and receive `amount` of the counter, at `to`.
    function redeem(uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        counter.safeTransfer(to, amount);
        emit Redeemed(msg.sender, to, amount);
    }

    /// @notice How much of the counter is held. Always at least the supply; more only if someone sent some
    /// directly, which then belongs to nobody in particular and can never be withdrawn.
    function reserve() external view returns (uint256) {
        return counter.balanceOf(address(this));
    }
}
