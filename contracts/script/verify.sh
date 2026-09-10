#!/usr/bin/env bash
# Verify every contract of a deployment record. Sourcify is the default: Robinhood Chain's Blockscout sits behind a
# challenge that refuses scripted requests, and Sourcify matches on compiler metadata, so it needs no constructor
# arguments, which matters for the coins and the names because a contract created by a contract has no creation
# transaction to read them from. Blockscout imports Sourcify matches.
# Usage: script/verify.sh [deployments/4663.json] ; VERIFIER=blockscout to use the explorer directly,
#        VERIFY_ONLY=Factory,TICKR to limit it, VERIFY_PAUSE=8 to pace it.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
REC="${1:-deployments/4663.json}"
CHAIN=$(python3 -c "import json;print(json.load(open('$REC')).get('chainId', 4663))")
if [ "$CHAIN" = "11155111" ]; then
  HOST="https://eth-sepolia.blockscout.com"; RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
else
  HOST="https://robinhoodchain.blockscout.com"; RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
fi
VERIFIER="${VERIFIER:-sourcify}"
if [ "$VERIFIER" = "blockscout" ]; then FLAGS=(--verifier blockscout --verifier-url "$HOST/api" --guess-constructor-args); else FLAGS=(--verifier sourcify); fi
addr() { python3 -c "import json,sys;print(json.load(open('$REC')).get('$1',''))"; }
verify() { # name path address
  local a; a=$(addr "$3"); [ -n "$a" ] && [ "$a" != "0x0000000000000000000000000000000000000000" ] || { echo "skip $1: no address"; return; }
  if [ -n "${VERIFY_ONLY:-}" ] && ! echo ",$VERIFY_ONLY," | grep -q ",$1,"; then return; fi
  local out try pause; pause="${VERIFY_PAUSE:-4}"
  for try in 1 2 3 4; do
    out=$(forge verify-contract "$a" "$2" --chain-id "$CHAIN" --rpc-url "$RPC" "${FLAGS[@]}" --watch 2>&1)
    if echo "$out" | grep -qE "successfully verified|already verified|Status: .?match"; then echo "ok   $1 $a"; sleep "$pause"; return; fi
    if echo "$out" | grep -qE "Too many requests|429"; then sleep $((pause * 3 * try)); continue; fi
    echo "FAIL $1 $a: $(echo "$out" | grep -E "Error|error" | head -1 | cut -c1-100)"; sleep "$pause"; return
  done
  echo "FAIL $1 $a: rate limited after four tries"
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
verify MarketQuoteLauncher src/mode5/MarketQuoteLauncher.sol:MarketQuoteLauncher marketQuoteLauncherDeployed
verify ZapRouter src/ZapRouter.sol:ZapRouter zapRouter
# after genesis: the official name and the official coin; every later coin and name shares their bytecode
verify FUN src/ManagedTickerToken.sol:ManagedTickerToken genesisTicker
verify TICKR src/Token.sol:Token genesisToken
echo "done: anything marked FAIL needs a look on $HOST"
