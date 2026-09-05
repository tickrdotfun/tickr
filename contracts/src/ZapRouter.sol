// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {ITickerToken} from "./interfaces/ITickerToken.sol";
import {LaunchedToken} from "./Types.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3PoolMinimal.sol";

/// @notice Buy any coin with ETH (or any token) in one transaction, through its pool and whatever pools lead to it.
///
/// The caller supplies the route: a list of Uniswap v4 pool keys and Uniswap v3 pool addresses walked from the input
/// asset to the coin's quote asset. Consecutive v4 hops run inside one PoolManager unlock; v3 hops call the pool
/// directly and pay it in the swap callback. Native ETH is wrapped before a v3 hop and unwrapped before a v4 hop that
/// prices native ETH, so a route can mix both. The router forwards the coin to the recipient. It holds nothing between
/// transactions and has no privileges.
///
/// `previewZap` runs the same path and reverts with the amounts, so a front end can quote it with a plain eth_call.
contract ZapRouter is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    uint8 public constant HOP_V4 = 0;
    uint8 public constant HOP_V3 = 1;
    /// @dev An invented ticker: a one-for-one wrapper of its counter asset. `pool` is the wrapper. Going in
    /// mints, coming out redeems; which one is meant follows from what the router is holding at that step.
    uint8 public constant HOP_WRAP = 2;

    struct Hop {
        uint8 kind; // HOP_V4: `key` is used; HOP_V3 and HOP_WRAP: `pool` is used
        PoolKey key;
        address pool;
    }

    struct ZapParams {
        address token; // the launch token to buy
        address tokenIn; // address(0) = native ETH; then msg.value is the amount
        uint256 amountIn; // for ERC-20 input; ignored for native
        Hop[] path; // hops from tokenIn to the coin, ending with the coin's own pool; never empty
        uint256 minTokensOut; // the fewest coins acceptable for the input
        address recipient; // address(0) = msg.sender
        uint256 deadline;
    }

    IFactory public immutable factory;
    IPoolManager public immutable poolManager;
    IWETH9 public immutable weth;

    // set only for the duration of one v3 swap so the callback can check its caller and cap what it pays
    address private _v3Pool;
    address private _v3In;
    uint256 private _v3Max;

    struct ZapSellParams {
        address token; // the launch token to sell
        uint256 amountIn; // coins to sell
        Hop[] path; // hops from the coin to tokenOut, starting with the coin's own pool; never empty
        address tokenOut; // address(0) = native ETH
        uint256 minOut; // in tokenOut units
        address recipient; // address(0) = msg.sender
        uint256 deadline;
    }

    event ZapSold(
        address indexed token,
        address indexed recipient,
        address tokenOut,
        uint256 amountIn,
        uint256 quoteOut,
        uint256 amountOut
    );
    event Zapped(
        address indexed token,
        address indexed recipient,
        address tokenIn,
        uint256 amountIn,
        uint256 quoteOut,
        uint256 tokensOut
    );

    error Expired();
    error UnknownToken();
    error BadPath();
    error BadValue();
    error InsufficientLiquidity();
    error OnlyPoolManager();
    error OnlyPool();
    error Slippage();
    /// @dev Not an error: `previewZap` always ends by reverting with this, so it can be read with eth_call.
    error Preview(uint256 quoteOut, uint256 tokensOut);

    constructor(IFactory factory_, IPoolManager pm, IWETH9 weth_) {
        factory = factory_;
        poolManager = pm;
        weth = weth_;
    }

    function zapBuy(ZapParams calldata p) external payable nonReentrant returns (uint256 tokensOut) {
        (, tokensOut) = _zap(p);
    }

    /// @notice Simulate a zap. Always reverts with `Preview(quoteOut, tokensOut)`.
    function previewZap(ZapParams calldata p) external payable {
        (uint256 q, uint256 t) = _zap(p);
        revert Preview(q, t);
    }

    /// @notice Sell a coin through its pool and leave with ETH (or any token) in one transaction.
    function zapSell(ZapSellParams calldata p) external nonReentrant returns (uint256 amountOut) {
        (, amountOut) = _zapSell(p);
    }

    /// @notice Simulate a sell. Always reverts with `Preview(quoteOut, amountOut)`.
    function previewZapSell(ZapSellParams calldata p) external {
        (uint256 q, uint256 a) = _zapSell(p);
        revert Preview(q, a);
    }

    function _zapSell(ZapSellParams calldata p) internal returns (uint256 quoteOut, uint256 amountOut) {
        if (block.timestamp > p.deadline) revert Expired();
        LaunchedToken memory l = factory.getLaunchedToken(p.token);
        if (!l.exists) revert UnknownToken();
        if (p.amountIn == 0) revert BadValue();
        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        IERC20(p.token).safeTransferFrom(msg.sender, address(this), p.amountIn);
        // 1. the route starts at the coin itself: its pool is the first hop
        if (p.path.length == 0 || !_isOwnPool(p.path[0], p.token)) revert BadPath();
        (address cur, uint256 amt) = _walk(p.path, p.token, p.amountIn);
        quoteOut = 0;
        if (cur == address(weth) && p.tokenOut == address(0)) {
            weth.withdraw(amt);
            cur = address(0);
        }
        if (cur != p.tokenOut) revert BadPath();
        if (amt < p.minOut) revert Slippage();
        amountOut = amt;

        // 3. hand it over
        if (cur == address(0)) _sendNative(recipient, amt);
        else IERC20(cur).safeTransfer(recipient, amt);

        emit ZapSold(p.token, recipient, p.tokenOut, p.amountIn, quoteOut, amountOut);
    }

    function _zap(ZapParams calldata p) internal returns (uint256 quoteOut, uint256 tokensOut) {
        if (block.timestamp > p.deadline) revert Expired();
        LaunchedToken memory l = factory.getLaunchedToken(p.token);
        if (!l.exists) revert UnknownToken();
        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        // 1. take the input
        uint256 amountIn;
        if (p.tokenIn == address(0)) {
            amountIn = msg.value;
            if (amountIn == 0) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            amountIn = p.amountIn;
            if (amountIn == 0) revert BadValue();
            IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // 2. walk the route to the coin: its own pool is the last hop, and `minTokensOut` is an absolute minimum
        if (p.path.length == 0 || !_isOwnPool(p.path[p.path.length - 1], p.token)) revert BadPath();
        (address c, uint256 a) = _walk(p.path, p.tokenIn, amountIn);
        if (c != p.token) revert BadPath();
        // what the router holds is what it forwards: inside its launch window a coin taxes the buy on its way out of
        // the pool, so the pool's own count of the output is more than arrived here
        a = IERC20(p.token).balanceOf(address(this));
        if (a < p.minTokensOut) revert Slippage();
        IERC20(p.token).safeTransfer(recipient, a);
        tokensOut = a;
        quoteOut = 0;
        l;
        emit Zapped(p.token, recipient, p.tokenIn, amountIn, quoteOut, tokensOut);
    }

    /// @dev Best-effort: a helper that cannot act (in band, paused, stale, empty) does nothing.

    /// @dev The coin's own pool, as the factory records it, and nothing that merely outputs the same token.
    function _isOwnPool(Hop calldata hop, address token) internal view returns (bool) {
        return hop.kind == HOP_V4 && PoolId.unwrap(hop.key.toId()) == factory.poolIdOf(token);
    }

    /// @dev Walk the hops. Runs of v4 hops share one unlock; each v3 hop is a direct pool call.
    function _walk(Hop[] calldata path, address cur, uint256 amt) internal returns (address, uint256) {
        uint256 i;
        while (i < path.length) {
            if (path[i].kind == HOP_V4) {
                uint256 j = i;
                while (j < path.length && path[j].kind == HOP_V4) j++;
                PoolKey[] memory run = new PoolKey[](j - i);
                for (uint256 k; k < run.length; k++) {
                    run[k] = path[i + k].key;
                }
                // v4 pools quote native ETH, not WETH: unwrap when the next pool is a native one
                if (cur == address(weth) && run[0].currency0.isAddressZero() && Currency.unwrap(run[0].currency1) != address(weth)) {
                    weth.withdraw(amt);
                    cur = address(0);
                }
                bytes memory res = poolManager.unlock(abi.encode(cur, amt, run));
                (cur, amt) = abi.decode(res, (address, uint256));
                i = j;
            } else if (path[i].kind == HOP_V3) {
                if (cur == address(0)) {
                    weth.deposit{value: amt}();
                    cur = address(weth);
                }
                (cur, amt) = _swapV3(path[i].pool, cur, amt);
                i++;
            } else if (path[i].kind == HOP_WRAP) {
                (cur, amt) = _wrapHop(path[i].pool, cur, amt);
                i++;
            } else {
                revert BadPath();
            }
        }
        return (cur, amt);
    }

    /// @dev One for one either way, so the amount never changes: holding the counter mints the wrapper, holding
    /// the wrapper redeems the counter. Anything else at this step is a malformed path.
    function _wrapHop(address wrapper, address cur, uint256 amt) internal returns (address, uint256) {
        address counter = address(ITickerToken(wrapper).counter());
        if (cur == counter) {
            IERC20(counter).forceApprove(wrapper, amt);
            ITickerToken(wrapper).mint(amt, address(this));
            return (wrapper, amt);
        }
        if (cur == wrapper) {
            ITickerToken(wrapper).redeem(amt, address(this));
            return (counter, amt);
        }
        revert BadPath();
    }

    function _swapV3(address pool, address cur, uint256 amt) internal returns (address out, uint256 amountOut) {
        IUniswapV3PoolMinimal v3 = IUniswapV3PoolMinimal(pool);
        address t0 = v3.token0();
        address t1 = v3.token1();
        bool zeroForOne;
        if (t0 == cur) zeroForOne = true;
        else if (t1 == cur) zeroForOne = false;
        else revert BadPath();

        _v3Pool = pool;
        _v3In = cur;
        _v3Max = amt;
        (int256 d0, int256 d1) = v3.swap(
            address(this),
            zeroForOne,
            int256(amt),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        delete _v3Pool;
        delete _v3In;
        delete _v3Max;

        (int256 dIn, int256 dOut) = zeroForOne ? (d0, d1) : (d1, d0);
        // a partial fill means the pool ran dry; the rest would be stranded inside the router
        if (dIn != int256(amt)) revert InsufficientLiquidity();
        amountOut = uint256(-dOut);
        out = zeroForOne ? t1 : t0;
    }

    /// @notice Uniswap v3 swap callback: pay the pool the input it is owed, and never more than this hop holds.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (_v3Pool == address(0) || msg.sender != _v3Pool) revert OnlyPool();
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        if (owed > _v3Max) revert InsufficientLiquidity();
        IERC20(_v3In).safeTransfer(msg.sender, owed);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (address cur, uint256 amt, PoolKey[] memory path) = abi.decode(data, (address, uint256, PoolKey[]));
        for (uint256 i; i < path.length; i++) {
            PoolKey memory k = path[i];
            bool zeroForOne;
            if (Currency.unwrap(k.currency0) == cur) zeroForOne = true;
            else if (Currency.unwrap(k.currency1) == cur) zeroForOne = false;
            else revert BadPath();

            BalanceDelta d = poolManager.swap(
                k,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amt),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            (Currency cIn, Currency cOut) = zeroForOne ? (k.currency0, k.currency1) : (k.currency1, k.currency0);
            (int128 dIn, int128 dOut) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
            uint256 used = uint256(uint128(-dIn));
            uint256 out = uint256(uint128(dOut));
            // hitting the price limit means the pool ran dry; a partial hop would strand the rest inside the router
            if (used != amt) revert InsufficientLiquidity();

            if (cIn.isAddressZero()) {
                poolManager.settle{value: used}();
            } else {
                poolManager.sync(cIn);
                IERC20(Currency.unwrap(cIn)).safeTransfer(address(poolManager), used);
                poolManager.settle();
            }
            poolManager.take(cOut, address(this), out);
            cur = Currency.unwrap(cOut);
            amt = out;
        }
        return abi.encode(cur, amt);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ZapRouter: native");
    }

    receive() external payable {}
}
