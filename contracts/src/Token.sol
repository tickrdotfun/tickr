// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Socials, LaunchedToken} from "./Types.sol";
import {IFactory} from "./interfaces/IFactory.sol";

/// @dev The two reads the coin needs at birth that the factory interface does not carry.
interface IFactorySeeder {
    function launchSeeder() external view returns (address);
}

interface ISeederPoolManager {
    function poolManager() external view returns (address);
}

/// @notice Immutable launch token. Fixed supply minted once to the deployer, which forwards all of it to the locked pool.
/// No mint, no burn hook, no freeze, no blacklist. One tax, and only in the coin's first five seconds: a buy out of
/// the pool by anyone but the launch's own wallets pays a snipe tax that starts at 99% and is gone by the fifth
/// second, burned to the dead address like every other coin-side fee. Sells never pay it. For the launch block and the two
/// after it, only the launch's own wallets may buy in the launch block, and every other wallet is held to 5% of supply
/// held, by buys or by transfers, and 5.5% bought. After that the coin is a plain ERC-20 forever.
contract Token is ERC20 {
    address public immutable factory;
    /// @notice The pool manager the coin trades in; a transfer out of it is a buy.
    address public immutable poolManager;
    address public immutable launchLocker;
    /// @notice When the coin launched. The snipe window counts from here, in whole seconds.
    uint64 public immutable launchedAt;
    /// @notice The block the coin launched in. Launch protection counts from here, in blocks.
    uint64 public immutable launchedBlock;
    /// @notice Seconds after launch during which a buy pays the snipe tax.
    uint256 public constant SNIPE_WINDOW = 5;
    /// @notice Blocks after the launch block during which buys are capped per wallet.
    uint256 public constant PROTECTION_BLOCKS = 2;
    /// @notice Inside the protected blocks, a wallet may hold at most this share of supply.
    uint256 public constant HOLD_CAP_BPS = 500;
    /// @notice Inside the protected blocks, a wallet may buy at most this share of supply, all its buys added up.
    uint256 public constant BUY_CAP_BPS = 550;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice What each wallet has bought out of the pool inside the protected blocks, net of the snipe tax.
    mapping(address => uint256) public boughtInWindow;

    /// @notice A buy inside the launch window paid its snipe tax to the dead address.
    event SnipeTaxed(address indexed to, uint256 amount, uint256 bps);

    /// @notice In the launch block only the launch's own wallets may buy.
    error LaunchBlock();
    /// @notice A buy or a transfer would leave `recipient` holding more than 5% of supply, or a buy would take it past 5.5% bought in the window.
    error WalletCapExceeded(address recipient, uint256 held, uint256 bought);
    string private _logo;
    string private _description;
    Socials private _socials;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        Socials memory socials_,
        uint256 supply_,
        address factory_
    ) ERC20(name_, symbol_) {
        factory = factory_;
        launchedAt = uint64(block.timestamp);
        launchedBlock = uint64(block.number);
        poolManager = ISeederPoolManager(IFactorySeeder(factory_).launchSeeder()).poolManager();
        launchLocker = IFactory(factory_).launchLocker();
        _logo = logo_;
        _description = description_;
        _socials = socials_;
        _mint(msg.sender, supply_);
    }

    function logo() external view returns (string memory) {
        return _logo;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function socials() external view returns (Socials memory) {
        return _socials;
    }


    /// @notice The Uniswap v4 pool this coin trades in, from its first block.
    function liquidityPool() external view returns (bytes32 poolId) {
        return IFactory(factory).poolIdOf(address(this));
    }

    /// @notice The snipe tax a buy pays right now if `recipient` receives it: 99% in the launch second, 25% one second
    /// in, 3% at two, then dust, then nothing from the fifth second on. Zero for the launch's own wallets. A quote
    /// must apply it, or it will not match what the trade settles at.
    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= SNIPE_WINDOW) return 0;
        if (_exempt(recipient)) return 0;
        return _snipeBps(elapsed);
    }

    function _snipeBps(uint256 elapsed) internal pure returns (uint256) {
        if (elapsed == 0) return 9_900;
        if (elapsed == 1) return 2_500;
        if (elapsed == 2) return 300;
        if (elapsed == 3) return 50;
        if (elapsed == 4) return 10;
        return 0;
    }

    /// @dev The launch's own wallets, the contracts the coin passes through on its way to and from the pool (the
    /// factory and the seeder that place the supply, the pool manager, the locker that collects the pool's fees, the
    /// escrow that holds the creator's coin), the protocol's fee wallet, and the dead address itself.
    function _exempt(address to) internal view returns (bool) {
        if (to == launchLocker || to == DEAD || to == poolManager || to == factory) return true;
        IFactory f = IFactory(factory);
        if (to == IFactorySeeder(factory).launchSeeder() || to == f.feeEscrow()) return true;
        LaunchedToken memory l = f.getLaunchedToken(address(this));
        if (to == l.deployer || to == l.creatorFeeRecipient) return true;
        return to == f.getLaunchFeePolicy(address(this)).protocolFeeRecipient;
    }

    /// @notice The first block in which buys are no longer capped: the launch block plus two more.
    function protectionEndsAtBlock() public view returns (uint256) {
        return uint256(launchedBlock) + PROTECTION_BLOCKS + 1;
    }

    /// @notice How much more `wallet` may buy out of the pool right now under launch protection, in coins. Unlimited
    /// after the window and for the launch's own wallets; nothing at all in the launch block.
    function remainingBuy(address wallet) public view returns (uint256) {
        if (block.number >= protectionEndsAtBlock() || _exempt(wallet)) return type(uint256).max;
        if (block.number == launchedBlock) return 0;
        uint256 cap = (totalSupply() * BUY_CAP_BPS) / 10_000;
        uint256 bought = boughtInWindow[wallet];
        return bought >= cap ? 0 : cap - bought;
    }

    /// @notice How much more `wallet` may hold before the hold cap stops what it can receive, bought or sent, in coins.
    /// Unlimited after the window and for the exempt set; in the launch block it says what a transfer may still bring,
    /// since buys are closed there anyway (`remainingBuy` is zero then).
    function remainingHold(address wallet) public view returns (uint256) {
        if (block.number >= protectionEndsAtBlock() || _exempt(wallet)) return type(uint256).max;
        uint256 cap = (totalSupply() * HOLD_CAP_BPS) / 10_000;
        uint256 held = balanceOf(wallet);
        return held >= cap ? 0 : cap - held;
    }

    /// @dev A buy is a transfer out of the pool manager. Inside the snipe window the tax leaves for the dead address
    /// first; inside the protected blocks the rest is then held to the wallet caps, and in the launch block only the
    /// launch's own wallets may buy at all. Inside the protected blocks a transfer from anywhere else is held to the
    /// hold cap too, so a holding over it cannot be assembled from several wallets; it counts as nothing bought.
    /// Sells, transfers into the exempt set, and everything after the window move untouched.
    function _update(address from, address to, uint256 value) internal override {
        if (value != 0 && from != address(0)) {
            bool protectedBlocks = block.number < protectionEndsAtBlock();
            if (from == poolManager) {
                bool snipeWindow = block.timestamp < launchedAt + SNIPE_WINDOW;
                if ((snipeWindow || protectedBlocks) && !_exempt(to)) {
                    if (snipeWindow) {
                        uint256 bps = _snipeBps(block.timestamp - launchedAt);
                        if (bps != 0) {
                            uint256 tax = (value * bps) / 10_000;
                            super._update(from, DEAD, tax);
                            emit SnipeTaxed(to, tax, bps);
                            value -= tax;
                        }
                    }
                    if (protectedBlocks) {
                        if (block.number == launchedBlock) revert LaunchBlock();
                        uint256 supply = totalSupply();
                        uint256 held = balanceOf(to) + value;
                        uint256 bought = boughtInWindow[to] + value;
                        if (held > (supply * HOLD_CAP_BPS) / 10_000 || bought > (supply * BUY_CAP_BPS) / 10_000) {
                            revert WalletCapExceeded(to, held, bought);
                        }
                        boughtInWindow[to] = bought;
                    }
                }
            } else if (protectedBlocks && from != to && !_exempt(to)) {
                uint256 held = balanceOf(to) + value;
                if (held > (totalSupply() * HOLD_CAP_BPS) / 10_000) revert WalletCapExceeded(to, held, boughtInWindow[to]);
            }
        }
        super._update(from, to, value);
    }

    function owner() external pure returns (address) {
        return address(0);
    }

    /// @notice ERC-7572 contract metadata, inline: name, symbol, description, image and links, as written at launch.
    function contractURI() external view returns (string memory) {
        return string.concat(
            "data:application/json;utf8,{\"name\":\"",
            _escape(name()),
            "\",\"symbol\":\"",
            _escape(symbol()),
            "\",\"description\":\"",
            _escape(_description),
            "\",\"image\":\"",
            _escape(_logo),
            "\",\"external_url\":\"",
            _escape(_socials.website),
            "\",\"twitter\":\"",
            _escape(_socials.twitter),
            "\",\"discord\":\"",
            _escape(_socials.discord),
            "\"}"
        );
    }

    /// @dev JSON string escaping: quotes, backslashes and control characters.
    function _escape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 extra;
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") extra += 1;
            else if (uint8(c) < 0x20) extra += 5;
        }
        if (extra == 0) return s;
        bytes memory out = new bytes(b.length + extra);
        bytes16 hexChars = "0123456789abcdef";
        uint256 j;
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") {
                out[j++] = "\\";
                out[j++] = c;
            } else if (uint8(c) < 0x20) {
                out[j++] = "\\";
                out[j++] = "u";
                out[j++] = "0";
                out[j++] = "0";
                out[j++] = hexChars[uint8(c) >> 4];
                out[j++] = hexChars[uint8(c) & 0x0f];
            } else {
                out[j++] = c;
            }
        }
        return string(out);
    }
}
