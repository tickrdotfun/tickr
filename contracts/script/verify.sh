#!/usr/bin/env bash
# Verify every contract of a deployment record on Blockscout (keyless), right after the deploy step and again after
# genesis for the two contracts genesis creates. Constructor arguments are read back from each contract's creation
# transaction by forge. Usage: script/verify.sh [deployments/4663.json]
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
REC="${1:-deployments/4663.json}"
URL="https://robinhoodchain.blockscout.com/api"
addr() { python3 -c "import json,sys;print(json.load(open('$REC')).get('$1',''))"; }
verify() { # name path address
  local a; a=$(addr "$3"); [ -n "$a" ] && [ "$a" != "0x0000000000000000000000000000000000000000" ] || { echo "skip $1: no address"; return; }
  echo "== $1 $a"
  forge verify-contract "$a" "$2" --chain-id 4663 --verifier blockscout --verifier-url "$URL" --guess-constructor-args --watch 2>&1 | grep -E "Contract successfully verified|already verified|Error|error" | head -2
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
echo "done: every contract above without a green line needs a look on https://robinhoodchain.blockscout.com"
