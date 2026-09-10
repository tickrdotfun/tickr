#!/usr/bin/env bash
# Robinhood Chain reports two block numbers: `block.number` inside the EVM (about 31 million lower) and the number
# on receipts, headers and `eth_blockNumber`, which is what `eth_getLogs` bounds are read against. A forge script can
# only see the first, so `startBlock` in the record comes out ~31 million too low and every log scan on the site
# starts far earlier than it needs to. This reads the factory's own creation block from its receipt and writes that.
# Usage: script/fix-start-block.sh [deployments/4663.json] [rpc]
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
REC="${1:-deployments/4663.json}"
RPC="${2:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN=$(python3 -c "import json;print(json.load(open('$REC')).get('chainId',4663))")
HASH=$(python3 -c "
import json;d=json.load(open('broadcast/Deploy.s.sol/$CHAIN/run-latest.json'))
print([t['hash'] for t in d['transactions'] if (t.get('contractName') or '')=='Factory'][0])")
BLOCK=$(cast receipt "$HASH" --rpc-url "$RPC" | awk '/^blockNumber/{print $2}')
[ -n "$BLOCK" ] || { echo "could not read the factory's creation block"; exit 1; }
python3 - "$REC" "$BLOCK" <<'PY'
import json, sys
rec, block = sys.argv[1], int(sys.argv[2])
d = json.load(open(rec)); was = d.get("startBlock")
d["startBlock"] = block
json.dump(d, open(rec, "w"), indent=2); open(rec, "a").write("\n")
print(f"startBlock {was} -> {block}")
PY
