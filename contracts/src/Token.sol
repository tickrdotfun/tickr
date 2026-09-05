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
/// second, burned to the dead address like every other coin-side fee. Sells never pay it. After the window the coin
/// is a plain ERC-20 forever.
contract Token is ERC20 {
    address public immutable factory;
    /// @notice The pool manager the coin trades in; a transfer out of it is a buy.
    address public immutable poolManager;
    address public immutable launchLocker;
    /// @notice When the coin launched. The snipe window counts from here, in whole seconds.
    uint64 public immutable launchedAt;
    /// @notice Seconds after launch during which a buy pays the snipe tax.
    uint256 public constant SNIPE_WINDOW = 5;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice A buy inside the launch window paid its snipe tax to the dead address.
    event SnipeTaxed(address indexed to, uint256 amount, uint256 bps);
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

    /// @dev The launch's own wallets, the locker that collects the pool's fees, and the dead address itself.
    function _exempt(address to) internal view returns (bool) {
        if (to == launchLocker || to == DEAD) return true;
        LaunchedToken memory l = IFactory(factory).getLaunchedToken(address(this));
        return to == l.deployer || to == l.creatorFeeRecipient;
    }

    /// @dev A buy is a transfer out of the pool manager. Inside the window the tax leaves for the dead address first;
    /// the rest goes where the buy was headed. Everything else moves untouched.
    function _update(address from, address to, uint256 value) internal override {
        if (from == poolManager && value != 0 && block.timestamp < launchedAt + SNIPE_WINDOW) {
            uint256 bps = currentSnipeTaxBps(to);
            if (bps != 0) {
                uint256 tax = (value * bps) / 10_000;
                super._update(from, DEAD, tax);
                emit SnipeTaxed(to, tax, bps);
                value -= tax;
            }
        }
        super._update(from, to, value);
    }

    /// @notice There is no owner and never was; scanners that ask get the zero address.
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
