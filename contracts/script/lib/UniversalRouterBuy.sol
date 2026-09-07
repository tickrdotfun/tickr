// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";

/// @dev Uniswap's Universal Router: `execute(commands, inputs, deadline)`, payable.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title UniversalRouterBuy
/// @notice The two activation buys, encoded exactly as the reference sent them through Uniswap's canonical Universal
/// Router: native ETH in, an explicit path of authenticated pool keys, the output paid to the wallet, and a positive
/// minimum from a fresh quote. Commands `V4_SWAP` then `SWEEP`; actions `SWAP_EXACT_IN`, `SETTLE_ALL`, `TAKE_ALL`.
/// Used by the genesis and seed scripts and by the fork test; the site encodes the same bytes in TypeScript.
library UniversalRouterBuy {
    bytes internal constant COMMANDS = hex"1004"; // V4_SWAP, SWEEP
    bytes internal constant ACTIONS = hex"070c0f"; // SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL

    /// @dev The path from native ETH through `pools`, in order; each pool must contain the currency the previous one
    /// left us holding. Returns the path and the final output currency.
    function path(PoolKey[] memory pools) internal pure returns (PathKey[] memory keys, address output) {
        keys = new PathKey[](pools.length);
        address input = address(0);
        for (uint256 i; i < pools.length; i++) {
            PoolKey memory k = pools[i];
            address c0 = Currency.unwrap(k.currency0);
            address c1 = Currency.unwrap(k.currency1);
            require(input == c0 || input == c1, "route: disconnected");
            output = input == c0 ? c1 : c0;
            keys[i] = PathKey({intermediateCurrency: Currency.wrap(output), fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: ""});
            input = output;
        }
    }

    /// @dev A fresh quote for `amountIn` of ETH along `pools`. Zero is refused: no buy is ever sent without a
    /// positive minimum. Not a view: the quoter unlocks and reverts inside, so call it outside a broadcast.
    function quote(IV4Quoter quoter, PoolKey[] memory pools, uint256 amountIn) internal returns (uint256 out) {
        (PathKey[] memory keys,) = path(pools);
        (out,) = quoter.quoteExactInput(IV4Quoter.QuoteExactParams({exactCurrency: Currency.wrap(address(0)), path: keys, exactAmount: uint128(amountIn)}));
        require(out > 0, "route: zero quote");
    }

    /// @dev The reference tolerance: one percent under the quote, never zero.
    function minimum(uint256 quoted) internal pure returns (uint256 m) {
        m = (quoted * 9_900) / 10_000;
        require(m > 0, "route: zero minimum");
    }

    /// @dev The `execute` arguments: `commands` and `inputs`. Output to `wallet`, the unspent ETH swept back to it.
    function encode(address wallet, PoolKey[] memory pools, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs)
    {
        require(amountIn > 0 && amountIn <= type(uint128).max && minOut > 0 && minOut <= type(uint128).max, "route: bounds");
        (PathKey[] memory keys, address output) = path(pools);
        require(wallet != address(0) && wallet != output, "route: recipient");
        bytes[] memory params = new bytes[](3);
        // the router decodes one ExactInputParams struct: encoded as that one dynamic tuple, offset word first,
        // exactly as the site encodes it, never as five loose fields that only happen to decode when currencyIn is zero
        params[0] = abi.encode(
            IV4Router.ExactInputParams({currencyIn: Currency.wrap(address(0)), path: keys, minHopPriceX36: new uint256[](0), amountIn: uint128(amountIn), amountOutMinimum: uint128(minOut)})
        );
        params[1] = abi.encode(Currency.wrap(address(0)), amountIn); // SETTLE_ALL: at most amountIn of ETH
        params[2] = abi.encode(Currency.wrap(output), minOut); // TAKE_ALL: at least minOut of the output, to the sender
        inputs = new bytes[](2);
        inputs[0] = abi.encode(ACTIONS, params);
        inputs[1] = abi.encode(address(0), wallet, uint256(0)); // SWEEP: native dust back to the wallet
        commands = COMMANDS;
    }

    /// @dev The full `execute` calldata, for a byte comparison against what the site sends.
    function calldataFor(address wallet, PoolKey[] memory pools, uint256 amountIn, uint256 minOut, uint256 deadline) internal pure returns (bytes memory) {
        (bytes memory commands, bytes[] memory inputs) = encode(wallet, pools, amountIn, minOut);
        return abi.encodeWithSelector(IUniversalRouter.execute.selector, commands, inputs, deadline);
    }

    /// @dev Quote, take the one percent minimum, send.
    function buy(IUniversalRouter router, address wallet, PoolKey[] memory pools, uint256 amountIn, uint256 minOut, uint256 deadline) internal {
        (bytes memory commands, bytes[] memory inputs) = encode(wallet, pools, amountIn, minOut);
        router.execute{value: amountIn}(commands, inputs, deadline);
    }
}
