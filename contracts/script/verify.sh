#!/usr/bin/env bash
# Verify every contract of a deployment record on Blockscout (keyless), right after the deploy step and again after
# genesis for the two contracts genesis creates. Constructor arguments are read back from each contract's creation
# transaction by forge. Usage: script/verify.sh [deployments/4663.json]
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
REC="${1:-deployments/4663.json}"
# the chain and its Blockscout come from the record: Robinhood Chain by default, Sepolia for the rehearsal
CHAIN=$(python3 -c "import json;print(json.load(open('$REC')).get('chainId', 4663))")
if [ "$CHAIN" = "11155111" ]; then HOST="https://eth-sepolia.blockscout.com"; RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; else HOST="https://robinhoodchain.blockscout.com"; RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"; fi
# constructor arguments are read back from each creation transaction, which needs a node: found on the Sepolia rehearsal, where the script had no RPC and every contract failed
URL="$HOST/api"
addr() { python3 -c "import json,sys;print(json.load(open('$REC')).get('$1',''))"; }
verify() { # name path address [constructor args hex]
  local a; a=$(addr "$3"); [ -n "$a" ] && [ "$a" != "0x0000000000000000000000000000000000000000" ] || { echo "skip $1: no address"; return; }
  if [ -n "${VERIFY_ONLY:-}" ] && ! echo ",$VERIFY_ONLY," | grep -q ",$1,"; then return; fi
  echo "== $1 $a"
  # a contract created by a contract (the coins, the names) has no creation transaction of its own to read the
  # constructor arguments from, so they are passed explicitly, read back from the contract itself
  local argflag; if [ -n "${4:-}" ]; then argflag="--constructor-args $4"; else argflag="--guess-constructor-args"; fi
  # Blockscout rate-limits verification requests from one address (seen on Sepolia: "Too many requests"), so
  # each contract gets up to four tries with a pause, and a pause between contracts
  local out try pause; pause="${VERIFY_PAUSE:-8}" # seconds between contracts; Sepolia's Blockscout wants more than Robinhood Chain's
  for try in 1 2 3 4; do
    out=$(forge verify-contract "$a" "$2" --chain-id "$CHAIN" --rpc-url "$RPC" --verifier blockscout --verifier-url "$URL" $argflag --watch 2>&1)
    if echo "$out" | grep -qE "Contract successfully verified|already verified"; then echo "$out" | grep -E "successfully verified|already verified" | head -1; sleep "$pause"; return; fi
    if echo "$out" | grep -q "Too many requests"; then sleep $((pause * 2 * try)); continue; fi
    echo "$out" | grep -E "Error|error|Warning" | head -3; sleep "$pause"; return
  done
  echo "gave up after four tries: $1 (rate limited)"
}
verify AnchorRegistry src/AnchorRegistry.sol:AnchorRegistry anchorRegistry
verify FeeEscrow src/FeeEscrow.sol:FeeEscrow feeEscrow
verify BuybackVault src/BuybackVault.sol:BuybackVault buybackVault
verify BuybackTreasury src/BuybackTreasury.sol:BuybackTreasury buybackTreasury
verify LaunchLocker src/LaunchLocker.sol:LaunchLocker launchLocker
verify LaunchDeployer src/LaunchDeployer.sol:LaunchDeployer launchDeployer
verify LaunchSeeder src/LaunchSeeder.sol:LaunchSeeder launchSeeder
verify Factory src/Factory.sol:Factory factory
verify LaunchAndBuyRouter src/LaunchAndBuyRouter.sol:LaunchAndBuyRouter launchAndBuyRouter
verify CoinQuoteLauncher src/mode3/CoinQuoteLauncher.sol:CoinQuoteLauncher coinQuoteLauncher
verify ManagedTickerHook src/ManagedTickerHook.sol:ManagedTickerHook managedTickerHook
verify ManagedTickerDeployer src/ManagedTickerDeployer.sol:ManagedTickerDeployer managedTickerDeployer
verify TickerLauncher src/TickerLauncher.sol:TickerLauncher tickerLauncher
verify StockQuoteLauncher src/mode4/StockQuoteLauncher.sol:StockQuoteLauncher stockQuoteLauncher
verify MarketQuoteLauncher src/mode5/MarketQuoteLauncher.sol:MarketQuoteLauncher marketQuoteLauncher
verify ZapRouter src/ZapRouter.sol:ZapRouter zapRouter
# after genesis: the official name and the official coin; every later coin and name shares their bytecode.
# both are created by contracts, so their constructor arguments are rebuilt from what they expose
FUN_ADDR=$(addr genesisTicker); TICKR_ADDR=$(addr genesisToken); DEP=$(addr managedTickerDeployer)
if [ -n "$FUN_ADDR" ] && [ "$FUN_ADDR" != "0x0000000000000000000000000000000000000000" ]; then
  sym=$(cast call "$FUN_ADDR" "symbol()(string)" --rpc-url "$RPC" | tr -d '"')
  FUN_ARGS=$(cast abi-encode "constructor(string,string,address,address,address,uint256)" "$sym" "$sym" \
    "$(cast call "$DEP" "counter()(address)" --rpc-url "$RPC")" "$(cast call "$DEP" "poolManager()(address)" --rpc-url "$RPC")" \
    "$(cast call "$DEP" "issuer()(address)" --rpc-url "$RPC")" "$(cast call "$DEP" "floor()(uint256)" --rpc-url "$RPC" | awk '{print $1}')")
  verify FUN src/ManagedTickerToken.sol:ManagedTickerToken genesisTicker "$FUN_ARGS"
fi
if [ -n "$TICKR_ADDR" ] && [ "$TICKR_ADDR" != "0x0000000000000000000000000000000000000000" ]; then
  # the supply is read as the total supply, which equals the constructor's supply until the first buyback burn:
  # run this right after genesis, as the runbook does
  TICKR_ARGS=$(python3 - "$TICKR_ADDR" "$RPC" <<'PY'
import subprocess, sys, ast, json
addr, rpc = sys.argv[1], sys.argv[2]
def call(sig): return subprocess.check_output(["cast", "call", addr, sig, "--rpc-url", rpc], text=True).strip()
def s(sig): return json.loads(call(sig)) if call(sig).startswith('"') else call(sig)
name, symbol, logo, desc = s("name()(string)"), s("symbol()(string)"), s("logo()(string)"), s("description()(string)")
socials = ast.literal_eval(call("socials()((string,string,string,string,string))"))
supply = call("totalSupply()(uint256)").split()[0]; factory = call("factory()(address)")
tup = "(" + ",".join(json.dumps(x) for x in socials) + ")"
print(subprocess.check_output(["cast", "abi-encode", "constructor(string,string,string,string,(string,string,string,string,string),uint256,address)", name, symbol, logo, desc, tup, supply, factory], text=True).strip())
PY
)
  verify TICKR src/Token.sol:Token genesisToken "$TICKR_ARGS"
fi
echo "done: every contract above without a green line needs a look on $HOST"
