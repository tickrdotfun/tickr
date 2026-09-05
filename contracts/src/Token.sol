// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Socials} from "./Types.sol";
import {IFactory} from "./interfaces/IFactory.sol";

/// @notice Immutable launch token. Fixed supply minted once to the deployer, which forwards all of it to the locked pool.
/// No mint, no burn hook, no freeze, no blacklist, no transfer tax.
contract Token is ERC20 {
    address public immutable factory;
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
