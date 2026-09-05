#!/usr/bin/env bash
# A self-contained tickr you can click through with a real wallet: plain anvil (no fork, so nothing ever goes
# stale), the real contracts, and local stand-ins for Uniswap v4, USDG, WETH and five Stock Tokens.
#   ./devnet.sh                      deployer = anvil account 0 (10,000 ETH, plus USDG and Stock Tokens)
#   TESTER=0xYourWallet ./devnet.sh  also funds your own wallet with ETH, USDG and Stock Tokens
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=http://127.0.0.1:8545
# a chain id no wallet has built in: Rabby and MetaMask map 4663 to the public Robinhood Chain and would send there
CHAIN_ID=${DEVNET_CHAIN_ID:-31337}
CHAIN_HEX=$(printf '0x%x' "$CHAIN_ID")
if [ "$CHAIN_ID" = "4663" ]; then echo "refusing chain id 4663: that is Robinhood Chain, and its deployment record is the preview's"; exit 1; fi
export PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80} # anvil account 0
TESTER=${TESTER:-}

pkill -9 -f anvil 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
lsof -ti tcp:3000 | xargs kill -9 2>/dev/null || true
sleep 1

echo "▸ anvil: a fresh chain with id $CHAIN_ID, one block a second"
nohup anvil --port 8545 --chain-id "$CHAIN_ID" --block-time 1 > /tmp/anvil.log 2>&1 &
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 3 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' $RPC | grep -q "$CHAIN_HEX"; then echo "  up"; break; fi
  if [ "$i" = 30 ]; then echo "anvil failed to start:"; tail -5 /tmp/anvil.log; exit 1; fi
done

cd "$ROOT/contracts"
echo "▸ planting the CREATE2 proxy, Permit2 and Multicall3 at their real addresses"
cast rpc anvil_setCode 0x4e59b44847b379578588920cA78FbF26c0B4956C "$(cat devnet/create2.hex)" --rpc-url $RPC >/dev/null
cast rpc anvil_setCode 0x000000000022D473030F116dDEE9F6B43aC78BA3 "$(cat devnet/permit2.hex)" --rpc-url $RPC >/dev/null
# the web app batches its reads through Multicall3, which a plain anvil does not have
cast rpc anvil_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 "$(cat devnet/multicall3.hex)" --rpc-url $RPC >/dev/null
if [ -n "$TESTER" ]; then cast rpc anvil_setBalance "$TESTER" 0x3635C9ADC5DEA00000 --rpc-url $RPC >/dev/null; echo "  $TESTER funded with 1,000 ETH"; fi

forge build --sizes --json 2>/dev/null | python3 -c '
import json,sys
over=[(k,v["runtime_size"]) for k,v in json.load(sys.stdin).items() if v["runtime_size"]>24576]
for k,n in over: print("  %s is %d bytes, over the 24,576 the chain enforces"%(k,n))
sys.exit(1 if over else 0)' || exit 1
echo "▸ deploying tickr and the local stand-ins"
TESTER="$TESTER" forge script script/Devnet.s.sol --tc Devnet --rpc-url $RPC --broadcast --slow 2>&1 | grep -aE "^\s+devnet|Error" || true
echo "▸ genesis: TICKR priced in FUN, the first launch, then launches open"
forge script script/Genesis.s.sol --rpc-url $RPC --broadcast --slow 2>&1 | grep -aE "^\s+genesis|Error" || true
echo "▸ seeding demo launches"
forge script script/Seed.s.sol --rpc-url $RPC --broadcast --slow --gas-estimate-multiplier 200 2>&1 | grep -aE "^\s*[0-9] |Error" || true

cd "$ROOT/web"
echo "▸ web: http://localhost:3000 (RPC $RPC)"
printf 'NEXT_PUBLIC_RPC_URL=%s\nNEXT_PUBLIC_CHAIN_ID=%s\n' "$RPC" "$CHAIN_ID" > .env.local
node scripts/sync-abis.mjs >/dev/null
NEXT_PUBLIC_CHAIN_ID="$CHAIN_ID" node scripts/sync-deployments.mjs >/dev/null
nohup pnpm dev -p 3000 > /tmp/tickr-dev.log 2>&1 &
sleep 8
curl -s -o /dev/null -w "  home %{http_code}\n" http://localhost:3000/
echo "▸ done."
echo "  wallet: add a custom network named tickr devnet, chain id $CHAIN_ID, RPC $RPC, currency ETH"
echo "  then import the key $PRIVATE_KEY, or use TESTER"
[ -n "$TESTER" ] && echo "  or use your own wallet $TESTER, which now holds 1,000 ETH, 1,000,000 USDG and 10,000 of each Stock Token"
echo "  open http://localhost:3000"
