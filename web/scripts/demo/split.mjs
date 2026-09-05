// Post-process the recording: every aggregate3 batch also contributes its individual calls, keyed on
// target + calldata, so replay can answer any batching of the same reads.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { splitAggregate3 } from "./aggregate3.mjs";
const OUT = fileURLToPath(new URL("../../public/demo-rpc.json", import.meta.url));
const map = JSON.parse(fs.readFileSync(OUT, "utf8"));
let batches = 0, inner = 0, failedInner = 0;
for (const [k, v] of Object.entries(map)) {
  if (!k.startsWith("eth_call|")) continue;
  let params;
  try { params = JSON.parse(k.slice("eth_call|".length)); } catch { continue; }
  const data = params?.[0]?.data;
  const parts = splitAggregate3(data, v);
  if (!parts) continue;
  batches++;
  for (const p of parts) {
    map[p.key] = { success: p.success, returnData: p.returnData };
    inner++;
    if (!p.success) failedInner++;
  }
}
fs.writeFileSync(OUT, JSON.stringify(map));
console.log(`split ${batches} aggregate3 batches into ${inner} individual calls (${failedInner} recorded as failed); map now ${Object.keys(map).length} keys, ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
