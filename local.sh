#!/usr/bin/env bash
# One-shot local stack: anvil fork of Robinhood Chain -> deploy tickr.fun -> seed demo launches -> web on :3000.
# The public Robinhood RPC is a pruned node, so the fork must be taken at latest and warmed immediately;
# if anvil ever stalls on a cold upstream read, just rerun this script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=http://127.0.0.1:8545
export PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80} # anvil account 0
# the fork writes its own record, never the real chain's deployments/4663.json
export DEPLOY_RECORD=deployments/4663-fork.json
export GENESIS_SEED=${GENESIS_SEED:-0x$(openssl rand -hex 32)}
export ENABLE_MARKET_QUOTES=${ENABLE_MARKET_QUOTES:-false}

pkill -9 -f anvil 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
lsof -ti tcp:3000 | xargs kill -9 2>/dev/null || true
sleep 1

echo "▸ anvil: forking Robinhood Chain (latest)"
nohup anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8545 --chain-id 4663 --timeout 120000 --retries 5 > /tmp/anvil.log 2>&1 &
for i in $(seq 1 45); do
  sleep 2
  if curl -s -m 5 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' $RPC | grep -q 0x1237; then echo "  up"; break; fi
  if [ "$i" = 45 ]; then echo "anvil failed to start:"; tail -5 /tmp/anvil.log; exit 1; fi
done

cd "$ROOT/contracts"
# the chain enforces EIP-170 (24,576 bytes of runtime) and foundry.toml lifts the test limit, so check here
forge build --sizes --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); found=[]
def walk(name, v):
    if isinstance(v, dict):
        if isinstance(v.get("runtime_size"), int): found.append((name, v["runtime_size"]))
        else:
            for k, x in v.items(): walk(k, x)
walk("", d)
assert found, "the size report listed no contracts: check `forge build --sizes --json`"
over=[(k,n) for k,n in found if n>24576]
for k,n in over: print("  %s is %d bytes, over the 24,576 the chain enforces; the fork would refuse to create it"%(k,n))
sys.exit(1 if over else 0)' || exit 1
echo "▸ deploying tickr.fun"
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -aE "^\s+(factory|hook|router|tickers) 0x|Error" || true
echo "▸ registering official Stock Tokens (verified against the fork)"
forge script script/RegisterStockTokens.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -aE "registered Stock Tokens|skipped|Error" || true

echo "▸ genesis: TICKR priced in FUN, the first launch, then launches open"
forge script script/Genesis.s.sol --rpc-url $RPC --broadcast --slow 2>&1 | grep -aE "^\s+genesis|Error" || true
# without the official coin the fork is not the product; stop here rather than record a site without it
grep -q genesisToken "$DEPLOY_RECORD" || { echo "genesis did not land on the fork; see above"; exit 1; }
echo "▸ seeding demo launches"
forge script script/Seed.s.sol --rpc-url $RPC --broadcast --slow --gas-estimate-multiplier 200 2>&1 | grep -aE "^\s*[0-9] |Error" || true
# warm every cold read the demo pages make against live-chain contracts, while the upstream still serves the fork block
(cd "$ROOT/web" && npx tsx --tsconfig tsconfig.json scripts/demo/warm.ts 2>&1 | tail -1) || true
# warm the multicall3 code so the web app's batched reads never hit a pruned upstream
cast call 0xcA11bde05977b3631167028862bE2a173976CA11 'getBlockNumber()(uint256)' --rpc-url $RPC >/dev/null 2>&1 || true

cd "$ROOT/web"
echo "▸ web: http://localhost:3000 (RPC $RPC)"
printf 'NEXT_PUBLIC_RPC_URL=%s\n' "$RPC" > .env.local
node scripts/sync-abis.mjs >/dev/null
nohup pnpm dev -p 3000 > /tmp/tickr-dev.log 2>&1 &
sleep 8
curl -s -o /dev/null -w "  home %{http_code}\n" http://localhost:3000/
echo "▸ done. Wallet: import anvil key $PRIVATE_KEY, network chain id 4663 at $RPC"
