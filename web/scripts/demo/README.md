# the demo recording

The preview deployment has no chain behind it. `public/demo-rpc.json` is a recording of the local anvil
fork's RPC traffic, and `src/lib/demoTransport.ts` replays it when `NEXT_PUBLIC_DEMO=1`.

Re-record after any change to the contracts, the hooks, or what the pages read:

1. have the fork and `next dev` running on :3000 with `.env.local` pointing at the fork
2. `node scripts/demo/record.mjs` drives every page and every tab and writes the recording
3. `node scripts/demo/split.mjs` keys each multicall batch by the calls inside it, so replay survives a
   different batching (this is the step that fixed an empty stock list)
4. deploy

`record.mjs` needs `playwright` with a browser installed; `split.mjs` needs `viem` (already a dependency).
Record with the default multicall setting: the recording is keyed on exact calldata, and forcing
`NEXT_PUBLIC_MULTICALL3=none` on either side misses everything.
