// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Permit2Batch} from "./lib/Permit2Batch.sol";

interface IProtectedCoin {
    function protectionEndsAtBlock() external view returns (uint256);
}

/// @notice Sends the airdrop `GenesisV2.s.sol` kept back, the whole list in one transaction: every recipient is paid
/// or none is. The payments go through Uniswap's canonical Permit2 (script/lib/Permit2Batch.sol), from the wallet
/// that holds them, so nothing of ours is deployed and nothing but the wallet can spend what it approves.
///
/// The list is a file, not a parameter: `{ "addresses": [...], "amounts": ["<raw units>", ...], "total": "<raw>" }`.
/// Amounts are decimal strings in the coin's raw units, so no reader rounds them. The file is bound by its SHA-256,
/// the one published with it (`shasum -a 256 <file>`): a list that differs by a byte is refused. Nothing is sent
/// unless the whole list checks out first:
///   - the file's SHA-256 is `AIRDROP_SHA256`;
///   - the amounts add up to exactly `total`, and every one is positive;
///   - no recipient is repeated, is the zero address, the sending wallet, or the coin itself;
///   - the coin's launch protection has ended, so no payment can meet its caps;
///   - the wallet holds exactly `total`. Less means some of it has gone somewhere already, more means the genesis
///     split is not what it should be; either way it stops for review instead of guessing.
/// There is nothing to resume. The batch either lands whole, leaving the wallet at zero, or reverts, leaving every
/// balance as it was; a second run after a landed one finds the wallet empty and refuses. The approvals it sends first
/// set absolute amounts, so repeating them after an interruption changes nothing.
///
/// `script/genesis-v2.mjs airdrop` runs this and then checks the batch's receipt against the list, entry by entry.
///
/// env:
///   EXPECTED_CHAIN   the chain id this run is meant for; anything else stops it
///   PRIVATE_KEY      the wallet holding the airdrop
///   AIRDROP_FILE     path to the list
///   AIRDROP_SHA256   the list file's published SHA-256
///   AIRDROP_TOKEN    the coin; defaults to the record's `genesisV2Token`
///   DEPLOY_RECORD    the record, relative to the project; default deployments/<chain id>.json
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
        string memory rec = vm.readFile(_recordPath());
        r.token = _token(rec);
        IAllowanceTransfer permit2 = IAllowanceTransfer(rec.readAddress(".permit2"));

        string memory file = vm.readFile(vm.envString("AIRDROP_FILE"));
        require(sha256(bytes(file)) == vm.envBytes32("AIRDROP_SHA256"), "airdrop: the list is not the published one (its SHA-256 differs)");
        address[] memory to = file.readAddressArray(".addresses");
        uint256[] memory amounts = file.readUintArray(".amounts");
        uint256 total = file.readUint(".total");

        _check(r.token, me, to, amounts, total);
        uint256 held = IERC20(r.token).balanceOf(me);
        require(held != 0, "airdrop: the wallet holds none of the coin: sent already?");
        require(held == total, "airdrop: the wallet does not hold exactly the list's total");
        console.log("  airdrop recipients", to.length);
        console.log("  airdrop to send, raw", total);

        vm.startBroadcast(pk);
        r.sent = Permit2Batch.send(permit2, r.token, me, to, amounts);
        vm.stopBroadcast();
        r.count = to.length;

        require(r.sent == total, "airdrop: sent a different amount than checked");
        console.log("  airdrop sent to", r.count, "wallets in one transaction");
    }

    function _recordPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
    }

    function _token(string memory rec) internal view returns (address) {
        address t = vm.envOr("AIRDROP_TOKEN", address(0));
        if (t != address(0)) return t;
        require(vm.keyExistsJson(rec, ".genesisV2Token"), "airdrop: no AIRDROP_TOKEN and no genesisV2Token in the record");
        return rec.readAddress(".genesisV2Token");
    }

    function _check(address token, address me, address[] memory to, uint256[] memory amounts, uint256 total) internal view {
        require(to.length > 0 && to.length == amounts.length, "airdrop: the list is empty or its columns differ in length");
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
        }
        require(sum == total, "airdrop: the amounts do not add up to the total");
    }
}
