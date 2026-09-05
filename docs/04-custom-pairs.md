# 04 · ETH, USDG and Stock Tokens (Mode 1)

> One of the custom pairs a launch can use. The others are an invented ticker (05), another coin (10), and a
> Stock Token sized from its feed (11).

A launch's `pairToken` is the asset its pool is paired with and priced in. It is fixed at creation and stored in `LaunchedToken.pairToken`. `address(0)` is native ETH; anything else must be an **approved** ERC-20.

## What "approved" means

```solidity
function approvedPairTokens(address pairToken) external view returns (bool);
```

Returns `true` for `address(0)`. For an ERC-20 it is true iff **both**:

1. `AnchorRegistry.isApproved(pairToken)`. the token is registered and active (kinds: 0 ETH, 1 USDG, 2 official Stock Token; see [05 Anchors](./05-anchors.md)), and
2. the factory has economics on file: `pairTokenEconomics(pairToken).phantomQuote != 0`.

Launching with an unapproved ERC-20 reverts `PairTokenNotApproved`.

## Per-asset economics

A phantom reserve is a *quantity of the quote asset*, so it cannot be shared across assets with different prices or decimals. The `LaunchConfig` carries native-ETH economics; each ERC-20 gets its own record:

```solidity
struct PairEconomics {
    uint256 phantomQuote;        // in the pair's base units
    uint256 phantomQuote; // in the pair's base units
    uint8 decimals;              // read from the token when approved
}

function pairTokenEconomics(address pairToken)
    external view returns (uint256 phantomQuote, uint256 phantomQuote, uint8 decimals);
```

Set by the owner with `setPairTokenEconomics(pairToken, phantomQuote, phantomQuote)`; it reads `decimals()` from the token at that moment and emits `PairTokenApproved(pairToken, phantomQuote, phantomQuote, decimals)`. Passing 0 for either amount deletes the record and emits `PairTokenRevoked`. Revoking affects new launches only.

Example, USDG (6 decimals):

| Field | Value |
|---|---|
| `phantomQuote` | `3_236e6` (3 236 USDG) |
| `phantomQuote` | `8_090e6` (8 090 USDG) |
| `decimals` | 6 |

These are the values the deploy script sets, with USDG registered in `AnchorRegistry` as kind 1 (issuer "Global Dollar Network"). The 0.4 phantom/threshold ratio matches the ETH config (1.68 / 4.2), so the curve shape, `reservedTokens`, and the 12.25× price multiple are the same as an ETH launch; only the unit of account differs.

For a native launch, `_resolveEconomics` returns `(config.phantomQuote, config.phantomQuote, 18)`.

## Decimals check

The factory reads `IERC20Metadata(pairToken).decimals()` at launch. If it differs from the recorded value the launch reverts `PairTokenDecimalsMismatch`. This protects against a pair whose decimals changed (or were misread) between approval and launch. `Curve.pairDecimals()` exposes the value for UIs.

## Pinning economics: `expectedEconomics`

Every economic term of a launch is hashed and must be passed back in `TokenParams.expectedEconomics`, so a launch can never settle on terms you did not read:

```solidity
function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
function previewLaunchEconomicsWithPair(uint256 launchConfigId, address pairToken, PairEconomics calldata econ)
    external view returns (bytes32); // registrar path (coin, stock and ticker launchers)
```

The hash is:

```solidity
keccak256(abi.encode(
    launchConfigId, config.supply, config.curveFeeBps,
    econ.phantomQuote, econ.phantomQuote, econ.decimals,
    config.poolFee, config.tickSpacing, pairToken
))
```

If the owner edits the config or the pair economics between your read and your transaction, the hash changes and `_launch` reverts `LaunchEconomicsMismatch`. Always call `previewLaunchEconomics` in the same block-height context as you build the transaction.

## Calling conventions

| | Native (`pairToken == address(0)`) | ERC-20 pair |
|---|---|---|
| `Factory.launchToken` | `value = launchFee()` | `value = launchFee()` |
| `LaunchAndBuyRouter.launchAndBuy` | `value = launchFee() + quoteIn` | `approve(router, quoteIn)`; `value = launchFee()` |
| Refunds on fill-to-edge | ETH sent back to `msg.sender` | ERC-20 sent back to `msg.sender` |
| Fees at sweep | `FeeEscrow.credit{value}` → `claim()` | `FeeEscrow.creditToken` → `claimToken(pairToken)` |
| The pool | `currency0 = address(0)` (ETH is always currency0) | currencies sorted by address |

The router refunds any leftover value or ERC-20 balance to `msg.sender` after the first buy.

## Risks of quote-asset exposure

- Registering an asset in `AnchorRegistry` is a suitability judgement, not an endorsement. Deactivating an anchor affects only new launches; existing curves keep trading in it.
- Invented tickers and other coins (see [05 Anchors](./05-anchors.md)) are never globally approved: `approvedPairTokens(quote)` stays `false`. They are admitted for one launch at a time through a registrar, with economics read from their live pool.
