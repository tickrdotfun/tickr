// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token that keeps two percent of every transfer, to stand in for a counter asset that takes a fee.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Dollar", "FUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 50;
            super._update(from, address(0xfee), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
