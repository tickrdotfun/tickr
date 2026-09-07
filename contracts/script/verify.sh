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
verify() { # name path address
  local a; a=$(addr "$3"); [ -n "$a" ] && [ "$a" != "0x0000000000000000000000000000000000000000" ] || { echo "skip $1: no address"; return; }
  echo "== $1 $a"
  # Blockscout rate-limits verification requests from one address (seen on Sepolia: "Too many requests"), so
  # each contract gets up to four tries with a pause, and a pause between contracts
  local out try
  for try in 1 2 3 4; do
    out=$(forge verify-contract "$a" "$2" --chain-id "$CHAIN" --rpc-url "$RPC" --verifier blockscout --verifier-url "$URL" --guess-constructor-args --watch 2>&1)
    if echo "$out" | grep -qE "Contract successfully verified|already verified"; then echo "$out" | grep -E "successfully verified|already verified" | head -1; sleep 8; return; fi
    if echo "$out" | grep -q "Too many requests"; then sleep $((30 * try)); continue; fi
    echo "$out" | grep -E "Error|error|Warning" | head -3; sleep 8; return
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
# after genesis: the official name and the official coin; every later coin and name shares their bytecode
verify FUN src/ManagedTickerToken.sol:ManagedTickerToken genesisTicker
verify TICKR src/Token.sol:Token genesisToken
echo "done: every contract above without a green line needs a look on $HOST"
