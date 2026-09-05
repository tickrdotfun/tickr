// Shared shape for the recorder: split a multicall3 aggregate3 call into its individual calls, so a
// recording is keyed on what was asked rather than on how it happened to be batched.
import { decodeFunctionData, decodeFunctionResult } from "viem";

export const AGG3_SELECTOR = "0x82ad56cb";

export const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
];

export const innerKey = (target, callData) => `call|${String(target).toLowerCase()}|${String(callData).toLowerCase()}`;

/** Returns [{key, success, returnData}] for one aggregate3 request/response pair, or null if it is not one. */
export function splitAggregate3(data, result) {
  if (!data?.toLowerCase().startsWith(AGG3_SELECTOR)) return null;
  try {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    const outs = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: result });
    const calls = args[0];
    if (!Array.isArray(calls) || !Array.isArray(outs) || calls.length !== outs.length) return null;
    return calls.map((c, i) => ({ key: innerKey(c.target, c.callData), success: outs[i].success, returnData: outs[i].returnData }));
  } catch {
    return null;
  }
}
