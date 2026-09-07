// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IAnchorRegistry} from "./interfaces/IAnchorRegistry.sol";
import {IFeeClub} from "./interfaces/IFeeClub.sol";
import {ILaunchSeeder} from "./interfaces/ILaunchSeeder.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {ITickerToken} from "./interfaces/ITickerToken.sol";
import {TokenParams, PairEconomics} from "./Types.sol";
import {ManagedTickerToken} from "./ManagedTickerToken.sol";
import {ManagedTickerHook} from "./ManagedTickerHook.sol";
import {ManagedTickerDeployer} from "./ManagedTickerDeployer.sol";

/// @title TickerLauncher
/// @notice Pair anything.
///
/// A launch names its pair. If the name is an invented ticker that exists, the coin is priced in it; if it does
/// not exist yet, it is created in the same transaction. An invented ticker is a `ManagedTickerToken`: a
/// one-for-one wrapper of USDG with the symbol somebody typed, running its own dollar pool against USDG behind
/// the one `ManagedTickerHook`, so the name has a market of its own that anything can trade at one dollar. So
/// BREAD/BANANA is a real pair on-chain and on every chart, and economically it is BREAD against USDG.
///
/// A ticker's address sits in the top sixteenth of the address space, and every coin under a ticker must sort
/// below it, so the coin is always currency0 of its pool and the name currency1: the base and the quote read the
/// same way everywhere. A launch whose coin would sort above its ticker reverts; the site grinds its salts for it.
///
/// Nobody owns a ticker: no owner slot, no rights over any other coin, no permission to ask before joining. What a
/// ticker has is a club: every coin priced in it pays the club's slice of its trade fee (10% of the 1% at deploy)
/// into a pot for that ticker, and the pot is shared by the creators of the *other* coins under the same ticker,
/// by their pool volume over the same thirty days. A coin never pays its own creator through the club; that is
/// what the creator's 60% is for. No volume in the window, no share.
///
/// Every club has a captain, and the captain counts double when a pot is split. The founder's coin, the first
/// launched under the ticker, is captain by default; in a window where it has no volume, the coin with the most
/// volume under the ticker takes the seat for that window, and the founder gets it back in any later window it
/// trades in. Any volume keeps the seat; there is no floor. The captain has nothing else: it cannot touch anyone's
/// fees, it keeps nobody out, and it owns nothing.
///
/// Time is cut into epochs of thirty days. Volume is recorded in the epoch it trades; club fees are booked in
/// the epoch they are swept. An epoch's pot is claimable once the epoch has closed, so nothing about a claim
/// can move after it becomes claimable. This contract has no owner.
contract TickerLauncher is ReentrancyGuard, IFeeClub {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCH = 30 days;

    IFactory public immutable factory;
    IAnchorRegistry public immutable registry;
    IERC20 public immutable usdg;
    ILaunchSeeder public immutable seeder;
    IPoolManager public immutable poolManager;
    /// @notice The one hook every ticker's dollar pool runs behind; this contract registers each new wrapper with it.
    ManagedTickerHook public immutable hook;
    /// @notice Deploys each wrapper at its CREATE2 address, for this contract alone.
    ManagedTickerDeployer public immutable wrapperDeployer;
    /// @notice The longest invented name, in bytes.
    uint256 public constant MAX_SYMBOL_LENGTH = 12;
    /// @notice What inventing a new ticker costs on top of the launch fee. It becomes the first dollars of the
    /// ticker's own pool: the wrapper's working surplus, which pays for keeping the pool at one dollar and is never
    /// part of the backing. Launching under a ticker that exists costs the launch fee alone.
    uint256 public constant NEW_TICKER_FEE = 0.0015 ether;
    /// @notice The fewest dollars the fee must buy for the wrapper to open; the wrapper's own minimum.
    uint256 public constant MIN_DONATION = 1_000_000;
    /// @notice The inventory every ticker's pool offers at rest, in the wrapper's six decimals: one million
    /// dollars' worth, so a single buy of up to that much fills whole while nothing is in circulation; the offer
    /// grows by four times whatever is out. Inventory is the wrapper's own unsold tokens, backed by nothing and
    /// owed to nobody until sold, when the dollars paid for them become their backing.
    uint256 public constant INVENTORY_FLOOR = 1_000_000e6;
    /// @dev A ticker's address always starts with this nibble, so a coin's can sort below it fifteen times in sixteen.
    uint160 internal constant TICKER_PREFIX = 0xF;

    mapping(bytes32 => address) internal _tickerOf;
    mapping(address => bool) public isTicker;
    address[] internal _tickers;
    /// @dev every coin ever launched under a ticker, in order
    mapping(address => address[]) internal _pairsOf;

    /// @notice Club fees booked: ticker => epoch => paying coin => amount of the ticker.
    mapping(address => mapping(uint256 => mapping(address => uint256))) public pot;
    /// @notice Pool volume in the ticker: coin => epoch => amount.
    mapping(address => mapping(uint256 => uint256)) public volumeOf;
    /// @notice Pool volume of every coin under a ticker: ticker => epoch => amount.
    mapping(address => mapping(uint256 => uint256)) public clubVolume;
    /// @notice The coin with the most volume under a ticker in an epoch, kept as volume lands, so nothing ever loops
    /// over the coins under a ticker. Ties keep the incumbent.
    mapping(address => mapping(uint256 => address)) public topOf;
    /// @notice paying coin => epoch => member coin => whether the member has taken its share of that pot.
    /// @notice How much of `payer`'s pot for `epoch` has been paid to `member`, so a pot booked late is still
    /// claimable for the rest, and nothing is ever paid twice.
    mapping(address => mapping(uint256 => mapping(address => uint256))) public paid;
    /// @dev A pot and the volume it stands for arrive in the same collection, so both land in the same epoch: a
    /// collection held back past a boundary moves a pot and its weight together, never one without the other.
    /// @notice Whether the protocol's share of a pot has been swept, per payer and epoch.
    /// @notice How much of the protocol's share of `payer`'s pot for `epoch` has been swept.
    mapping(address => mapping(uint256 => uint256)) public deadPaid;

    event TickerCreated(address indexed ticker, string symbol, address indexed by);
    event Launched(address indexed token, bytes32 indexed poolId, address indexed ticker);
    /// @notice The creator's own buy in the launch transaction: `quoteIn` USDG wrapped into the ticker and spent on the curve.
    event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);
    event ClubFee(address indexed ticker, uint256 indexed epoch, address indexed token, uint256 amount);
    event ClubClaimed(address indexed ticker, uint256 indexed epoch, address indexed member, address to, uint256 amount);
    event DeadPotSwept(address indexed ticker, uint256 indexed epoch, address indexed token, address to, uint256 amount);

    error NotFeeSource();
    error NotHook();
    error NotUnderTicker();
    error EpochOpen();
    error NothingToSweep();
    error BadValue();
    error EmptySymbol();
    error SymbolTooLong();
    error BadSymbol();
    /// @notice The coin's address must sort below its ticker's; grind the coin's salt until it does.
    error CoinNotFirst(address coin, address ticker);
    error TooFewDollars(uint256 got);

    constructor(
        IFactory factory_,
        IAnchorRegistry registry_,
        IERC20 usdg_,
        ILaunchSeeder seeder_,
        IPoolManager poolManager_,
        ManagedTickerHook hook_,
        ManagedTickerDeployer wrapperDeployer_
    ) {
        seeder = seeder_;
        factory = factory_;
        registry = registry_;
        usdg = usdg_;
        poolManager = poolManager_;
        hook = hook_;
        wrapperDeployer = wrapperDeployer_;
        if (hook_.issuer() != address(this) || hook_.poolManager() != poolManager_) revert BadSymbol();
        if (
            wrapperDeployer_.issuer() != address(this) || wrapperDeployer_.counter() != usdg_ || wrapperDeployer_.poolManager() != poolManager_
                || wrapperDeployer_.floor() != INVENTORY_FLOOR
        ) revert BadSymbol();
    }

    // ---------------------------------------------------------------- views

    function tickerFor(string calldata symbol) external view returns (address) {
        return _tickerOf[_key(symbol)];
    }

    function tickerCount() external view returns (uint256) {
        return _tickers.length;
    }

    function tickerAt(uint256 i) external view returns (address) {
        return _tickers[i];
    }

    /// @notice Every coin launched under `ticker`, oldest first. Graduated or not; the club weighs only pool volume.
    function pairsOf(address ticker) external view returns (address[] memory) {
        return _pairsOf[ticker];
    }

    function pairCount(address ticker) external view returns (uint256) {
        return _pairsOf[ticker].length;
    }

    /// @notice The `i`th coin launched under `ticker`, oldest first; the founder's coin is at zero.
    function pairAt(address ticker, uint256 i) external view returns (address) {
        return _pairsOf[ticker][i];
    }

    /// @inheritdoc IFeeClub
    function hasClub(address pairToken) external view override returns (bool) {
        return isTicker[pairToken];
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH;
    }

    /// @notice Where `symbol`'s ticker lives, whether or not it exists yet. Deterministic, so a launch can hash
    /// its terms against a ticker that will only be created inside the launch.
    function predictTicker(string calldata symbol) public view returns (address) {
        address existing = _tickerOf[_key(symbol)];
        if (existing != address(0)) return existing;
        (, address predicted) = _tickerSalt(_key(symbol), _initCodeHash(_upper(symbol)));
        return predicted;
    }

    /// @notice The pool every ticker trades in against USDG: the wrapper's own key.
    function poolKeyOf(address ticker) external view returns (PoolKey memory) {
        if (!isTicker[ticker]) revert NotUnderTicker();
        return ManagedTickerToken(ticker).poolKey();
    }

    /// @notice The economics every coin under a ticker launches with: the same as USDG's, because a ticker is
    /// USDG. Read immediately before `launch` and pass `expected` as `coin.expectedEconomics`.
    function previewLaunch(string calldata symbol, uint256 launchConfigId)
        external
        view
        returns (address ticker, bool exists, bytes32 expected, PairEconomics memory econ)
    {
        ticker = predictTicker(symbol);
        exists = isTicker[ticker];
        econ = _economics();
        expected = factory.previewLaunchEconomicsWithPair(launchConfigId, ticker, econ);
    }

    /// @notice The captain of `ticker`'s club for `epoch`: the founder's coin, the first launched under the ticker,
    /// whenever it has volume in the epoch; otherwise the coin with the most volume; zero when nothing traded. Final
    /// once the epoch has closed, which is when claims open, so no claim can see the seat move.
    function captainOf(address ticker, uint256 epoch) public view returns (address) {
        address[] storage coins = _pairsOf[ticker];
        if (coins.length == 0) return address(0);
        address founder = coins[0];
        if (volumeOf[founder][epoch] > 0) return founder;
        return topOf[ticker][epoch];
    }

    /// @dev A coin's weight in a split: its volume, doubled for the captain.
    function _weight(address coin, address captain, uint256 epoch) internal view returns (uint256) {
        uint256 v = volumeOf[coin][epoch];
        return coin == captain ? v * 2 : v;
    }

    /// @dev The sum of every weight under the ticker, without a loop: all the volume, plus the captain's once more.
    function _totalWeight(address ticker, address captain, uint256 epoch) internal view returns (uint256) {
        return clubVolume[ticker][epoch] + volumeOf[captain][epoch];
    }

    /// @notice What `member` would receive from the pots of `payers` for a closed `epoch`. Zero for an open
    /// epoch, for a member with no volume, and for pots already taken.
    function claimable(address member, address[] calldata payers, uint256 epoch) external view returns (uint256 amount) {
        if (epoch >= currentEpoch()) return 0;
        address ticker = _pairOf(member);
        if (!isTicker[ticker] || volumeOf[member][epoch] == 0) return 0;
        address captain = captainOf(ticker, epoch);
        uint256 w = _weight(member, captain, epoch);
        uint256 total = _totalWeight(ticker, captain, epoch);
        for (uint256 i; i < payers.length; i++) {
            address p = payers[i];
            if (p == member || _pairOf(p) != ticker) continue;
            uint256 share = (pot[ticker][epoch][p] * w) / total;
            uint256 done = paid[p][epoch][member];
            if (share > done) amount += share - done;
        }
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launch `coin` priced in the ticker `symbol`, creating the ticker if it is new. `msg.value` is the
    /// launch fee, plus `NEW_TICKER_FEE` when the ticker does not exist yet. The caller is the coin's deployer and
    /// creator, exactly as on any other launch.
    function launch(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId)
        external
        payable
        nonReentrant
        returns (address ticker, address token, bytes32 poolId)
    {
        return _launch(symbol, coin, launchConfigId);
    }

    /// @notice `launch`, then the creator's first buy in the same transaction: `usdgIn` USDG is pulled from the
    /// caller, wrapped one-for-one into the ticker and spent in the new pool, coins to the caller. `minTokensOut`
    /// bounds the rate.
    function launchAndBuy(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId, uint256 usdgIn, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (address ticker, address token, bytes32 poolId, uint256 tokensOut)
    {
        (ticker, token, poolId) = _launch(symbol, coin, launchConfigId);
        if (usdgIn == 0) return (ticker, token, poolId, 0);
        // the club pots live here, in the ticker: only what this buy minted may leave with the buyer
        uint256 before = IERC20(ticker).balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        usdg.forceApprove(ticker, usdgIn);
        ITickerToken(ticker).mint(usdgIn, address(this));
        IERC20(ticker).forceApprove(address(seeder), usdgIn);
        PoolKey memory key = factory.poolKeyOf(token);
        tokensOut = seeder.swapExactIn(key, Currency.unwrap(key.currency0) == ticker, usdgIn, minTokensOut, msg.sender);
        _returnLeftover(ticker, before);
        emit FirstBuy(token, usdgIn, tokensOut);
    }

    function _launch(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId)
        internal
        returns (address ticker, address token, bytes32 poolId)
    {
        uint256 fee = factory.launchFee();
        ticker = _tickerOf[_key(symbol)];
        if (ticker == address(0)) {
            if (msg.value != fee + NEW_TICKER_FEE) revert BadValue();
            ticker = _create(symbol);
        } else {
            if (msg.value != fee) revert BadValue();
        }
        (token, poolId) = factory.launchTokenWithPair{value: fee}(msg.sender, coin, launchConfigId, ticker, _economics());
        // the coin is currency0 of its pool and the name currency1, on every chart the same way round
        if (token >= ticker) revert CoinNotFirst(token, ticker);
        _pairsOf[ticker].push(token);
        emit Launched(token, poolId, ticker);
    }

    // ---------------------------------------------------------------- the club

    /// @inheritdoc IFeeClub
    function onClubFee(address token, uint256 amount) external override {
        if (msg.sender != factory.launchLocker()) revert NotFeeSource();
        address ticker = _pairOf(token);
        if (!isTicker[ticker]) revert NotUnderTicker();
        uint256 epoch = currentEpoch();
        pot[ticker][epoch][token] += amount;
        emit ClubFee(ticker, epoch, token, amount);
    }

    /// @inheritdoc IFeeClub
    function recordVolume(address token, uint256 quoteAmount) external override {
        if (msg.sender != factory.launchLocker()) revert NotHook();
        address ticker = _pairOf(token);
        if (!isTicker[ticker] || quoteAmount == 0) return;
        uint256 epoch = currentEpoch();
        volumeOf[token][epoch] += quoteAmount;
        clubVolume[ticker][epoch] += quoteAmount;
        // the leader is kept as volume lands; a tie keeps the incumbent
        address top = topOf[ticker][epoch];
        if (top != token && volumeOf[token][epoch] > volumeOf[top][epoch]) topOf[ticker][epoch] = token;
    }

    /// @notice Pay `member`'s creator its share of the pots `payers` filled in a closed `epoch`. Anyone may call;
    /// the money goes to the member's current fee recipient. A member's share of one payer's pot is the pot times
    /// the member's weight over the weight of every coin under the ticker, the payer included, where a weight is a
    /// coin's volume and the captain's is twice that; the payer's own share of its pot is the protocol's, so a coin
    /// with dust volume earns dust. Each pot is taken once per member.
    function claimClub(address member, address[] calldata payers, uint256 epoch)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (epoch >= currentEpoch()) revert EpochOpen();
        address ticker = _pairOf(member);
        if (!isTicker[ticker]) revert NotUnderTicker();
        if (volumeOf[member][epoch] == 0) return 0;
        address captain = captainOf(ticker, epoch);
        uint256 w = _weight(member, captain, epoch);
        uint256 total = _totalWeight(ticker, captain, epoch);
        for (uint256 i; i < payers.length; i++) {
            address p = payers[i];
            if (p == member || _pairOf(p) != ticker) continue;
            uint256 share = (pot[ticker][epoch][p] * w) / total;
            uint256 done = paid[p][epoch][member];
            if (share <= done) continue;
            paid[p][epoch][member] = share;
            amount += share - done;
        }
        if (amount == 0) return 0;
        address to = factory.creatorFeeRecipientOf(member);
        IERC20(ticker).safeTransfer(to, amount);
        emit ClubClaimed(ticker, epoch, member, to, amount);
    }

    /// @notice The part of a pot nobody else can claim goes to the protocol once the epoch has closed: the payer's
    /// own share of its pot, by its weight, or the whole pot when no coin under the ticker had volume.
    function sweepDeadPot(address token, uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (epoch >= currentEpoch()) revert EpochOpen();
        address ticker = _pairOf(token);
        if (!isTicker[ticker]) revert NotUnderTicker();
        address captain = captainOf(ticker, epoch);
        uint256 total = _totalWeight(ticker, captain, epoch);
        uint256 potAmount = pot[ticker][epoch][token];
        uint256 share = total == 0 ? potAmount : (potAmount * _weight(token, captain, epoch)) / total;
        uint256 done = deadPaid[token][epoch];
        if (share <= done) revert NothingToSweep();
        amount = share - done;
        deadPaid[token][epoch] = share;
        address to = factory.getLaunchFeePolicy(token).protocolFeeRecipient;
        IERC20(ticker).safeTransfer(to, amount);
        emit DeadPotSwept(ticker, epoch, token, to, amount);
    }

    // ---------------------------------------------------------------- internals

    function _pairOf(address token) internal view returns (address) {
        return factory.getLaunchedToken(token).pairToken;
    }

    function _create(string calldata symbol) internal returns (address ticker) {
        bytes memory b = bytes(symbol);
        if (b.length == 0) revert EmptySymbol();
        if (b.length > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        // letters and digits only: no lookalikes of NVDA, USDG or ETH through other scripts or punctuation
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
            if (!ok) revert BadSymbol();
        }
        // the factory refuses reserved symbols on the coin; the ticker must refuse them too, or BANANA could
        // be called NVDA on every chart while the coin under it is called something innocent
        if (registry.isReservedTicker(symbol)) revert IFactory.TickerReserved();
        bytes32 key = _key(symbol);
        string memory upper = _upper(symbol);
        (bytes32 salt, address predicted) = _tickerSalt(key, _initCodeHash(upper));
        ticker = wrapperDeployer.deploy(salt, upper);
        assert(ticker == predicted);
        _tickerOf[key] = ticker;
        isTicker[ticker] = true;
        _tickers.push(ticker);
        // the wrapper is bound to the one hook, and the fee for the name becomes its first dollars through the
        // live ETH/USDG pool: the working surplus its pool opens with
        hook.register(ManagedTickerToken(ticker));
        uint256 got = seeder.swapExactIn{value: NEW_TICKER_FEE}(_ethUsdgKey(), true, NEW_TICKER_FEE, MIN_DONATION, address(this));
        if (got < MIN_DONATION) revert TooFewDollars(got);
        usdg.forceApprove(ticker, got);
        ManagedTickerToken(ticker).initialize(address(hook), got);
        emit TickerCreated(ticker, upper, msg.sender);
    }

    /// @dev The salt, and the address it gives, for a ticker: the first salt in the name's own sequence whose
    /// address starts with `TICKER_PREFIX`. Sixteen tries on average, the same in a preview as at creation.
    function _tickerSalt(bytes32 key, bytes32 initCodeHash) internal view returns (bytes32 salt, address predicted) {
        for (uint256 i;; i++) {
            salt = keccak256(abi.encode(key, i));
            predicted = Create2.computeAddress(salt, initCodeHash, address(wrapperDeployer));
            if (uint160(predicted) >> 156 == TICKER_PREFIX) return (salt, predicted);
        }
    }

    function _ethUsdgKey() internal view returns (PoolKey memory k) {
        (k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks) = seeder.ethUsdgKey();
    }

    /// @dev A ticker wraps USDG, so a coin under it launches on USDG's terms. Read live from the factory, so
    /// an owner change to USDG's economics carries over to every ticker without a second setting to forget.
    function _economics() internal view returns (PairEconomics memory e) {
        (uint256 phantom,) = factory.pairTokenEconomics(address(usdg));
        e = PairEconomics({phantomQuote: phantom, decimals: IERC20Metadata(address(usdg)).decimals()});
    }

    function _initCodeHash(string memory upper) internal view returns (bytes32) {
        return wrapperDeployer.initCodeHash(upper);
    }

    /// @dev Upper-cases ASCII, so BANANA, banana and Banana are one ticker.
    function _upper(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7a) b[i] = bytes1(uint8(b[i]) - 32);
        }
        return string(b);
    }

    function _key(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(_upper(s)));
    }

    /// @dev What the pool did not take came back here from the seeder; it goes on to the buyer. Measured against
    /// the balance before the buyer's funds came in, so nothing this contract held before can leave with them.
    function _returnLeftover(address asset, uint256 before) internal {
        uint256 now_ = IERC20(asset).balanceOf(address(this));
        if (now_ > before) IERC20(asset).safeTransfer(msg.sender, now_ - before);
    }
}
