// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {ILaunchSeeder} from "./interfaces/ILaunchSeeder.sol";
import {TokenParams} from "./Types.sol";

/// @notice Create a launch and make its first buy in one transaction, so the creator is first in their own pool.
/// Native pair: value = launchFee + quoteIn. ERC-20 pair: approve quoteIn to this router, value = launchFee.
contract LaunchAndBuyRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IFactory public immutable factory;
    ILaunchSeeder public immutable seeder;

    event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);

    error BadValue();

    constructor(IFactory factory_, ILaunchSeeder seeder_) {
        factory = factory_;
        seeder = seeder_;
    }

    function launchAndBuy(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient
    ) external payable nonReentrant returns (address token, bytes32 poolId, uint256 tokensOut) {
        uint256 fee = factory.launchFee();
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 tokenBefore;
        if (pairToken == address(0)) {
            if (msg.value != fee + quoteIn) revert BadValue();
        } else {
            if (msg.value != fee) revert BadValue();
            tokenBefore = IERC20(pairToken).balanceOf(address(this));
            if (quoteIn > 0) IERC20(pairToken).safeTransferFrom(msg.sender, address(this), quoteIn);
        }
        if (recipient == address(0)) recipient = msg.sender;
        (token, poolId) = factory.launchTokenFor{value: fee}(msg.sender, params, launchConfigId, pairToken);
        if (quoteIn > 0) {
            PoolKey memory key = factory.poolKeyOf(token);
            bool zeroForOne = Currency.unwrap(key.currency0) == pairToken;
            if (pairToken == address(0)) {
                tokensOut = seeder.swapExactIn{value: quoteIn}(key, zeroForOne, quoteIn, minTokensOut, recipient);
                // whatever the pool did not take came back here and goes on to the buyer
                uint256 left = address(this).balance - ethBefore;
                if (left > 0) {
                    (bool ok,) = msg.sender.call{value: left}("");
                    if (!ok) revert BadValue();
                }
            } else {
                IERC20(pairToken).forceApprove(address(seeder), quoteIn);
                tokensOut = seeder.swapExactIn(key, zeroForOne, quoteIn, minTokensOut, recipient);
                uint256 nowBal = IERC20(pairToken).balanceOf(address(this));
                if (nowBal > tokenBefore) IERC20(pairToken).safeTransfer(msg.sender, nowBal - tokenBefore);
            }
            emit FirstBuy(token, quoteIn, tokensOut);
        }
    }

    receive() external payable {}
}
