# tickr.fun — web

Frontend for the tickr.fun launchpad on Robinhood Chain (chain id 4663). Next.js App Router + TypeScript, Tailwind v4, wagmi v2 + viem v2, TanStack Query. Wallet: injected connector only (MetaMask / Rabby).

## Run

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build (also runs sync-deployments)
pnpm start
```

`pnpm dev` / `pnpm build` first run `scripts/sync-deployments.mjs`, which copies `../contracts/deployments/4663.json` into `src/lib/deployments.json` when it exists, otherwise falls back to `src/lib/deployments.example.json` (zero protocol addresses). If the factory address is zero the UI shows a "contracts not deployed yet" banner.

## Env vars

All optional. Values in `contracts/deployments/4663.json` take precedence; env vars are the fallback, then zero addresses.

| var | meaning |
| --- | --- |
| `NEXT_PUBLIC_FACTORY` | Factory |
| `NEXT_PUBLIC_HOOK` | MemeHook |
| `NEXT_PUBLIC_FEE_ESCROW` | FeeEscrow |
| `NEXT_PUBLIC_LAUNCH_LOCKER` | LaunchLocker |
| `NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER` | LaunchAndBuyRouter |
| `NEXT_PUBLIC_ANCHOR_REGISTRY` | AnchorRegistry |
| `NEXT_PUBLIC_DIY_LAUNCHER` | DiyLauncher (Mode 2) |
| `NEXT_PUBLIC_POOL_MANAGER` | Uniswap v4 PoolManager (default 0x8366…0951) |
| `NEXT_PUBLIC_POSITION_MANAGER` | Uniswap v4 PositionManager (default 0x58da…4fA7) |
| `NEXT_PUBLIC_USDG` | USDG (default 0x5fc5…d168, 6 decimals) |
| `NEXT_PUBLIC_WETH` | WETH (default 0x0Bd7…AD73) |
| `NEXT_PUBLIC_START_BLOCK` | Block to scan `TokenLaunched` logs from |
| `NEXT_PUBLIC_RPC_URL` | Override RPC (default https://rpc.mainnet.chain.robinhood.com) |
| `NEXT_PUBLIC_MULTICALL3` | Override Multicall3 address, or `none` to disable batching |

Put them in `.env.local`.

## ABIs

`src/lib/abis/*.ts` are generated from the Foundry artifacts in `../contracts/out`. After `forge build` in `contracts/`, regenerate with:

```sh
pnpm sync-abis
```

Generated files are committed so the app builds without a Foundry toolchain.

## Pages

- `/` launches, newest first, with quote chip, phase, and graduation progress
- `/create` launch form (ETH / USDG / official stock / DIY ticker), optional first buy via `LaunchAndBuyRouter`
- `/t/[address]` token page: price, progress, buy/sell, finish-launch, creator fees, Mode 2 panel
- `/docs` pointers to `docs/SPEC.md`


## Brand

The UI implements `branding2/BRANDING.md` exactly. Tokens live at the top of `src/app/globals.css`
(`--tickr-ink`, `--tickr-green`, `--tickr-signal`, `--tickr-black`, `--tickr-white`); every semantic colour
(`--bg`, `--border`, `--accent`, `--buy`, ...) resolves to one of them. Two rules that break the brand if ignored:

- **One family, Source Serif 4, for everything** including buttons, labels, inputs and tables. It is loaded via
  `next/font/google` in `src/app/layout.tsx`; `--font-sans`, `--font-mono` and Tailwind's preflight defaults are all
  pointed at it, so no sans-serif or monospace can reach the DOM. Tabular figures come from the `.num` class.
- **Signal green is spot colour only**: the mark's dot, eyebrow labels, links, focus rings, active tab underline, the
  progress-bar head, hairlines at low opacity. Never a fill. Brand green (`--tickr-green`) is the fill for primary buttons.

The mark is `src/components/Mark.tsx`: `<TickrMark size>` renders `tıckr` with the per-letter swatch colours and
hand-set bounce (white `t`, yellow `ı`, red `c`, pink `k`, blue `r`) and the detached signal dot; `buildIn` plays the
sanctioned build-in (letters rise left to right, dot drops last), `onLight` switches to the light-ground palette.
`<TickrIcon>` is the `t` + dot lockup for sizes under 24px; `<SwatchBar>` is the six-swatch rail, used once in the footer.
The swatch colours exist only for the logo and the rail; the only one that reaches UI is swatch red on market-down numbers. Brand PNGs are in `public/brand/`; `src/app/icon.png`, `apple-icon.png` and
`opengraph-image.png` come from the same exports. Layout is flush-left and separated by whitespace; the only rule
printed is the `.rule` thick-thin hairline pair. Bordered `.row-card`s are reserved for discrete list items.
