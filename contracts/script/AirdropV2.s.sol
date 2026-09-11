// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IProtectedCoin {
    function protectionEndsAtBlock() external view returns (uint256);
}

/// @notice Sends the airdrop `GenesisV2.s.sol` kept back: one plain transfer per recipient, from the wallet that holds
/// it. Plain transfers because the recipients are wallets, and a transfer is the one thing every wallet can receive
/// and every explorer shows plainly, one hash per holder.
///
/// The list is a file, not a parameter: `{ "addresses": [...], "amounts": ["<raw units>", ...], "total": "<raw>" }`.
/// Amounts are decimal strings in the coin's raw units, so no reader rounds them. Nothing is sent unless the whole
/// list checks out first:
///   - the amounts add up to exactly `total`, and every one is positive;
///   - no recipient is repeated, is the zero address, the sending wallet, or the coin itself;
///   - the coin's launch protection has ended, so no transfer can meet its caps;
///   - the wallet holds at least what is left to send.
/// Afterwards the wallet's balance must have fallen by exactly what was sent.
///
/// A run that stops part way can be resumed: `AIRDROP_FROM` skips the entries already sent, by index, and the
/// broadcast file forge writes for the first run says which those are.
///
/// env:
///   EXPECTED_CHAIN   the chain id this run is meant for; anything else stops it
///   PRIVATE_KEY      the wallet holding the airdrop
///   AIRDROP_FILE     path to the list
///   AIRDROP_TOKEN    the coin; defaults to the record's `genesisV2Token`
///   AIRDROP_FROM     index to resume from, default 0
///
/// This file holds one contract and must stay that way (`forge script` needs `--tc` otherwise).
contract AirdropV2 is Script {
    using stdJson for string;

    struct Result {
        address token;
        uint256 count;
        uint256 sent;
    }

    function run() external returns (Result memory r) {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "airdrop: wrong chain");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        r.token = _token();

        string memory j = vm.readFile(vm.envString("AIRDROP_FILE"));
        address[] memory to = j.readAddressArray(".addresses");
        uint256[] memory amounts = j.readUintArray(".amounts");
        uint256 total = j.readUint(".total");
        uint256 from = vm.envOr("AIRDROP_FROM", uint256(0));

        uint256 left = _check(r.token, me, to, amounts, total, from);
        uint256 before = IERC20(r.token).balanceOf(me);
        require(before >= left, "airdrop: the wallet holds less than is left to send");
        console.log("  airdrop recipients", to.length - from, "of", to.length);
        console.log("  airdrop to send, raw", left);

        vm.startBroadcast(pk);
        for (uint256 i = from; i < to.length; i++) {
            IERC20(r.token).transfer(to[i], amounts[i]);
            r.count++;
            r.sent += amounts[i];
        }
        vm.stopBroadcast();

        require(r.sent == left, "airdrop: sent a different amount than checked");
        require(IERC20(r.token).balanceOf(me) == before - left, "airdrop: the wallet's balance did not fall by exactly what was sent");
        console.log("  airdrop sent to", r.count, "wallets");
    }

    function _token() internal view returns (address) {
        address t = vm.envOr("AIRDROP_TOKEN", address(0));
        if (t != address(0)) return t;
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory rec = vm.readFile(path);
        require(vm.keyExistsJson(rec, ".genesisV2Token"), "airdrop: no AIRDROP_TOKEN and no genesisV2Token in the record");
        return rec.readAddress(".genesisV2Token");
    }

    /// @return left what remains to send from `from` onwards
    function _check(address token, address me, address[] memory to, uint256[] memory amounts, uint256 total, uint256 from)
        internal
        view
        returns (uint256 left)
    {
        require(to.length > 0 && to.length == amounts.length, "airdrop: the list is empty or its columns differ in length");
        require(from < to.length, "airdrop: nothing left to send from that index");
        require(block.number >= IProtectedCoin(token).protectionEndsAtBlock(), "airdrop: the coin's launch protection has not ended");
        uint256 sum;
        for (uint256 i; i < to.length; i++) {
            address a = to[i];
            require(a != address(0) && a != me && a != token, "airdrop: a recipient is the zero address, the wallet or the coin");
            require(amounts[i] > 0, "airdrop: an amount is zero");
            for (uint256 k; k < i; k++) {
                require(to[k] != a, "airdrop: a recipient appears twice");
            }
            sum += amounts[i];
            if (i >= from) left += amounts[i];
        }
        require(sum == total, "airdrop: the amounts do not add up to the total");
    }
}
