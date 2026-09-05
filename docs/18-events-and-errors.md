# 18 · Events and errors

## Events

```solidity
// Factory
event TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed deployer, address pairToken, uint256 launchConfigId, uint24 poolFee, uint256 phantomQuote);
event LaunchPositionLocked(address indexed token, uint256 lpTokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
event CreatorFeeRecipientUpdated(address indexed token, address indexed newRecipient);
event FeeClubUpdated(address club);
// LaunchSeeder
event LaunchSeeded(address indexed token, bytes32 indexed poolId, uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
event DollarPoolSeeded(address indexed wrapper, bytes32 poolId, uint256 usdgIn, uint256 wrapperIn, uint256 tokenId);
// LaunchLocker
event PositionLocked(address indexed positionManager, uint256 indexed tokenId);
event FeesCollected(address indexed token, uint256 quoteCollected, uint256 coinCollected, uint256 protocolQuote, uint256 creatorQuote, uint256 clubQuote, uint256 creatorCoin, uint256 burnedCoin);
// routers and launchers
event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);
event TickerCreated(address indexed ticker, string symbol, address indexed by);
event Launched(address indexed token, bytes32 indexed poolId, address indexed ticker);
// PoolManager, filtered by poolId: the input currency is negative and includes the fee, the output positive
event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee);
```

## Errors

| error | where | what to do |
| --- | --- | --- |
| `LaunchEconomicsMismatch` | factory | the terms changed since your preview. re-read the preview and retry. |
| `LaunchFeeNotPaid` | factory | value must equal `launchFee`. |
| `BadValue` | ticker launcher, seeder | value must equal `launchFee + NEW_TICKER_FEE` for a new ticker, `launchFee` for an existing one. |
| `CreatorTaxTooHigh` | factory | the tax is above `maxCreatorTaxBps`. |
| `TickerReserved`, `NameReserved` | factory, ticker launcher | the symbol or name belongs to an official asset. |
| `PairTokenNotApproved`, `PairTokenDecimalsMismatch` | factory | the quote asset is not on the list, or its decimals changed. |
| `LaunchConfigDisabled`, `UnknownLaunchConfig` | factory | the config id is closed or does not exist. |
| `NotWhitelisted` | factory | launches are gated. check `canLaunch(address)`. |
| `NotRegistrar` | registry | only a registrar may add anchors. |
| `Slippage` | seeder, zap | the output fell under `minOut`. |
| `BadPath`, `Expired` | zap | the route does not end at the coin's pool, or the deadline passed. |
| `EpochOpen`, `NotUnderTicker`, `NothingToSweep` | ticker launcher | the club epoch is still running, the coin is not under that ticker, or the pot is empty. |
| `QuoteIsAnchor`, `QuoteLaunchedHere`, `NoMarket`, `QuotePriceUnavailable`, `NoTargetRaise` | market quote launcher | the token is an anchor or a tickr coin (use that path), has no v3 pool over the floor, or its price cannot be read. |
| `PoolAlreadyExists` | seeder | somebody opened the coin's pool key first. change the salt and launch again. |
| `PositionNotLocked`, `NotPositionManager` | seeder, locker | the position did not land in the locker, or something other than the position manager tried to hand it one. |
| `RefundFailed` | seeder | the input the pool did not take could not be sent back to the caller. |
| `EmptyMetadata`, `MetadataTooLong`, `BadName`, `BadSymbol` | deployer | name or symbol empty, a field over its limit, a name with a space at either end, two spaces in a row or a byte outside printable ASCII, or a symbol with anything but letters and digits. |
| `QuoteDecimals` | market quote launcher | the token has fewer than six decimals. |
| `SymbolTooLong`, `BadSymbol` | ticker launcher | an invented name is over twelve bytes, or has a character that is not a letter or a digit. |
| `NotAMint` | locker | somebody tried to transfer an existing position into the locker; only launch mints land there. |
| `OnlyTickerLauncher` | seeder | only the ticker launcher named on the factory may open a dollar pool. |
| `OnlyExecutor`, `NotOneDollar`, `OutsideTheBand`, `PriceGuard` | guard hook | the dollar pool refuses anything but the seeder's own opening, a position off the band, or a swap that would move the price. |

## Versioning and attribution

The contracts are immutable; a new version is a new factory and a new deployment record. If you build on tickr, say so and link the site; do not present your service as run by tickr.
