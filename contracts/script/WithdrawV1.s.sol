// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";

/// @notice The v1 liquidity withdrawal, the whole of it, as one set of steps the broadcaster runs on positions it
/// owns: burn each position and take both sides; burn every TICKR that came out; redeem every FUN that came out
/// for dollars; send the dollars to the HOLY treasury and have it count them (`collect` with nothing else to
/// claim), so they are split between the team wallet and HOLY buybacks the way every other dollar is.
///
/// Only what the positions produce moves: balances are read before and after, so anything the broadcaster held
/// already stays where it was. The two v1 positions were the genesis 50,000,000 TICKR band and its re-placement;
/// by now they are almost all coin, so this is mostly a burn.
library V1Withdrawal {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Out {
        uint256 tickrBurned;
        uint256 funRedeemed;
        uint256 usdgSent;
    }

    function withdraw(IPositionManager posm, uint256[] memory ids, address tickr, address fun, address usdg, address treasury)
        internal
        returns (Out memory o)
    {
        uint256 t0 = IERC20(tickr).balanceOf(address(this));
        uint256 f0 = IERC20(fun).balanceOf(address(this));
        uint256 u0 = IERC20(usdg).balanceOf(address(this));
        for (uint256 i; i < ids.length; i++) {
            (PoolKey memory key,) = posm.getPoolAndPositionInfo(ids[i]);
            bytes memory actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(ids[i], uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(key.currency0, key.currency1, address(this));
            posm.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
        }
        o.tickrBurned = IERC20(tickr).balanceOf(address(this)) - t0;
        o.funRedeemed = IERC20(fun).balanceOf(address(this)) - f0;
        if (o.tickrBurned > 0) IERC20(tickr).transfer(DEAD, o.tickrBurned);
        if (o.funRedeemed > 0) ManagedTickerToken(fun).redeem(o.funRedeemed, address(this));
        o.usdgSent = IERC20(usdg).balanceOf(address(this)) - u0;
        if (o.usdgSent > 0) {
            IERC20(usdg).transfer(treasury, o.usdgSent);
            address[] memory none = new address[](0);
            QuoteConverter.Terms[] memory noneT = new QuoteConverter.Terms[](0);
            BuybackTreasuryV2(payable(treasury)).collect(none, noneT);
        }
    }
}

interface IERC721Transfer {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// env: LP_TOKEN_IDS (comma separated), TREASURY (the HOLY treasury); PRIVATE_KEY or a prompt. The broadcaster must
/// own every position listed.
contract WithdrawV1 is Script {
    using stdJson for string;

    function run() external {
        require(block.chainid == 4663, "mainnet only");
        string memory rec = vm.readFile(string.concat(vm.projectRoot(), "/deployments/4663.json"));
        IPositionManager posm = IPositionManager(rec.readAddress(".positionManager"));
        address tickr = rec.readAddress(".genesisToken");
        address fun = rec.readAddress(".genesisTicker");
        address usdg = rec.readAddress(".usdg");
        address treasury = vm.envAddress("TREASURY");
        uint256[] memory ids = vm.envUint("LP_TOKEN_IDS", ",");
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.promptSecretUint("wallet private key");

        vm.startBroadcast(pk);
        Runner r = new Runner();
        for (uint256 i; i < ids.length; i++) IERC721Transfer(address(posm)).transferFrom(vm.addr(pk), address(r), ids[i]);
        V1Withdrawal.Out memory o = r.go(posm, ids, tickr, fun, usdg, treasury);
        vm.stopBroadcast();

        console.log("TICKR burned", o.tickrBurned / 1e18);
        console.log("FUN redeemed (1e6)", o.funRedeemed / 1e6);
        console.log("USDG to the treasury (1e6)", o.usdgSent / 1e6);
    }
}

/// @dev The steps run inside a contract so `address(this)` is one place the positions, the coins and the dollars
/// pass through; the broadcaster hands it the positions and it keeps nothing.
contract Runner {
    function go(IPositionManager posm, uint256[] memory ids, address tickr, address fun, address usdg, address treasury)
        external
        returns (V1Withdrawal.Out memory)
    {
        return V1Withdrawal.withdraw(posm, ids, tickr, fun, usdg, treasury);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
