// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A registry of mock v3 pools with the factory's `getPool` shape. Register a pool for both token orders.
contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function set(address a, address b, uint24 fee, address pool) external {
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}
