// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Registers the official Stock Tokens listed in config/stock-tokens-<chainid>.json as anchors, each with
/// its Chainlink feed. Every entry is re-verified against the chain before it is registered: the symbol must match
/// the ticker, decimals must match, and the feed must return a positive price.
///
///   forge script script/RegisterStockTokens.s.sol --rpc-url robinhood --broadcast
contract RegisterStockTokens is Script {
    using stdJson for string;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory deployments = vm.readFile(vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        AnchorRegistry registry = AnchorRegistry(deployments.readAddress(".anchorRegistry"));

        string memory cfg = vm.readFile(string.concat("config/stock-tokens-", vm.toString(block.chainid), ".json"));
        address[] memory tokens = cfg.readAddressArray(".tokens");
        address[] memory feeds = cfg.readAddressArray(".feeds");
        string[] memory tickers = cfg.readStringArray(".tickers");
        string memory issuer = cfg.readString(".issuer");
        require(tokens.length == feeds.length && tokens.length == tickers.length, "config length mismatch");

        uint256 kept;
        address[] memory okTokens = new address[](tokens.length);
        address[] memory okFeeds = new address[](tokens.length);
        string[] memory okTickers = new string[](tokens.length);

        for (uint256 i; i < tokens.length; i++) {
            if (!_verify(tokens[i], feeds[i], tickers[i])) {
                console.log("skipped (failed verification):", tickers[i]);
                continue;
            }
            okTokens[kept] = tokens[i];
            okFeeds[kept] = feeds[i];
            okTickers[kept] = tickers[i];
            kept++;
        }
        require(kept > 0, "nothing verified");

        address[] memory finalTokens = new address[](kept);
        address[] memory finalFeeds = new address[](kept);
        string[] memory finalTickers = new string[](kept);
        for (uint256 i; i < kept; i++) {
            finalTokens[i] = okTokens[i];
            finalFeeds[i] = okFeeds[i];
            finalTickers[i] = okTickers[i];
        }

        // Register in chunks so one transaction never runs out of gas on a couple of hundred assets.
        uint256 CHUNK = 40;
        vm.startBroadcast(pk);
        for (uint256 start; start < kept; start += CHUNK) {
            uint256 end = start + CHUNK > kept ? kept : start + CHUNK;
            uint256 n = end - start;
            address[] memory ct = new address[](n);
            address[] memory cf = new address[](n);
            string[] memory ck = new string[](n);
            for (uint256 i; i < n; i++) {
                ct[i] = finalTokens[start + i];
                cf[i] = finalFeeds[start + i];
                ck[i] = finalTickers[start + i];
            }
            registry.registerMany(ct, ck, issuer, 2, cf);
            // reserve each asset's on-chain name() as well, so no launch can copy it
            string[] memory names = new string[](n);
            for (uint256 i; i < n; i++) {
                names[i] = IERC20Metadata(ct[i]).name();
            }
            registry.reserveNames(names, true);
        }
        vm.stopBroadcast();
        console.log("registered Stock Tokens:", kept, "of", tokens.length);
    }

    /// @dev An impostor can copy a name and ticker, so nothing is registered on the strength of the file alone.
    function _verify(address token, address feed, string memory ticker) internal view returns (bool) {
        // A feed is optional: an asset with none is still official, it just cannot be quoted until one exists.
        if (token == address(0)) return false;
        try IERC20Metadata(token).symbol() returns (string memory sym) {
            if (keccak256(bytes(sym)) != keccak256(bytes(ticker))) return false;
        } catch {
            return false;
        }
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            if (d != 18) return false;
        } catch {
            return false;
        }
        if (feed != address(0)) {
            try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
                if (answer <= 0 || updatedAt == 0) return false;
            } catch {
                return false;
            }
        }
        return true;
    }
}
