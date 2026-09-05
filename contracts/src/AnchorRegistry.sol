// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAnchorRegistry} from "./interfaces/IAnchorRegistry.sol";

/// @notice Allowlist of quote assets: native ETH, USDG, and official Stock Tokens issued by Robinhood Assets at canonical addresses.
/// Listing is a suitability judgement, not an endorsement. Deactivating an anchor only affects new launches.
contract AnchorRegistry is IAnchorRegistry, Ownable2Step {
    uint8 public constant KIND_NATIVE = 0;
    uint8 public constant KIND_STABLE = 1;
    uint8 public constant KIND_OFFICIAL_STOCK = 2;

    mapping(address => Anchor) private _anchors;
    address[] private _list;
    /// @dev Upper-cased tickers that a DIY quote may not imitate: every registered anchor's, plus any reserved by hand.
    mapping(bytes32 => bool) private _reserved;
    /// @dev Upper-cased token names that a launch may not copy, e.g. an official asset's on-chain name().
    mapping(bytes32 => bool) private _reservedNames;

    event TickerReserved(string ticker, bool reserved);
    event NameReserved(string name, bool reserved);

    constructor(address owner_) Ownable(owner_) {
        _anchors[address(0)] = Anchor({ticker: "ETH", issuer: "native", kind: KIND_NATIVE, active: true, feed: address(0)});
        _list.push(address(0));
        _reserved[_tickerKey("ETH")] = true;
        emit AnchorRegistered(address(0), "ETH", KIND_NATIVE, address(0));
    }

    function register(address token, string calldata ticker, string calldata issuer, uint8 kind, address feed)
        external
        onlyOwner
    {
        _register(token, ticker, issuer, kind, feed);
    }

    /// @notice Register many anchors at once. The official Stock Token set is a few dozen entries.
    function registerMany(
        address[] calldata tokens,
        string[] calldata tickers,
        string calldata issuer,
        uint8 kind,
        address[] calldata feeds
    ) external onlyOwner {
        require(tokens.length == tickers.length && tokens.length == feeds.length, "AnchorRegistry: length");
        for (uint256 i; i < tokens.length; i++) {
            _register(tokens[i], tickers[i], issuer, kind, feeds[i]);
        }
    }

    function _register(address token, string memory ticker, string memory issuer, uint8 kind, address feed) internal {
        require(token != address(0) && kind <= KIND_OFFICIAL_STOCK, "AnchorRegistry: bad anchor");
        if (bytes(_anchors[token].ticker).length == 0) _list.push(token);
        _anchors[token] = Anchor({ticker: ticker, issuer: issuer, kind: kind, active: true, feed: feed});
        _reserved[_tickerKey(ticker)] = true;
        emit AnchorRegistered(token, ticker, kind, feed);
        emit AnchorStatus(token, true);
    }

    /// @notice Reserve (or release) a ticker by hand, for names that are not anchors but must not be imitated.
    function reserveTicker(string calldata ticker, bool reserved) external onlyOwner {
        _reserved[_tickerKey(ticker)] = reserved;
        emit TickerReserved(ticker, reserved);
    }

    /// @notice Reserve (or release) token names, so a launch cannot copy an official asset's name().
    function reserveNames(string[] calldata names, bool reserved) external onlyOwner {
        for (uint256 i; i < names.length; i++) {
            _reservedNames[_tickerKey(names[i])] = reserved;
            emit NameReserved(names[i], reserved);
        }
    }

    function isReservedName(string calldata name) external view override returns (bool) {
        return _reservedNames[_tickerKey(name)];
    }

    function isReservedTicker(string calldata ticker) external view override returns (bool) {
        return _reserved[_tickerKey(ticker)];
    }

    /// @dev Case-insensitive for ASCII letters, so "nvda" and "NVDA" are the same ticker.
    function _tickerKey(string memory ticker) internal pure returns (bytes32) {
        bytes memory b = bytes(ticker);
        for (uint256 i; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7A) b[i] = bytes1(uint8(b[i]) - 32);
        }
        return keccak256(b);
    }

    function feedOf(address token) external view override returns (address) {
        return _anchors[token].feed;
    }

    function setActive(address token, bool active) external onlyOwner {
        require(bytes(_anchors[token].ticker).length != 0, "AnchorRegistry: unknown");
        _anchors[token].active = active;
        emit AnchorStatus(token, active);
    }

    function isApproved(address token) external view override returns (bool) {
        return _anchors[token].active;
    }

    function isOfficialStock(address token) external view override returns (bool) {
        Anchor storage a = _anchors[token];
        return a.active && a.kind == KIND_OFFICIAL_STOCK;
    }

    function anchorOf(address token) external view override returns (Anchor memory) {
        return _anchors[token];
    }

    function anchorCount() external view override returns (uint256) {
        return _list.length;
    }

    function anchorAt(uint256 i) external view override returns (address) {
        return _list[i];
    }
}
