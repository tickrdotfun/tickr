"use client";

import { useState, useSyncExternalStore } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { robinhoodChain } from "@/lib/chain";
import { DEMO } from "@/lib/demoTransport";
import { shortAddr } from "@/lib/format";

/** the wallets a phone can open this page inside, where a wallet is present. `href` takes the current page. */
const WALLET_APPS: { name: string; open: (url: string) => string }[] = [
  { name: "MetaMask", open: (u) => `https://metamask.app.link/dapp/${u.replace(/^https?:\/\//, "")}` },
  { name: "Coinbase Wallet", open: (u) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u)}` },
  { name: "Trust Wallet", open: (u) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(u)}` },
  { name: "Rabby", open: (u) => `https://rabby.io/?dapp=${encodeURIComponent(u)}` },
];

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [chooser, setChooser] = useState(false);
  // a browser without a wallet extension or app has no provider; the chooser shows the ways in instead of a dead
  // button. Read rather than stored: the server has no window, and assuming one there keeps the first paint the
  // same as what hydration finds when there is one
  const hasProvider = useSyncExternalStore(
    () => () => {},
    () => !!(window as { ethereum?: unknown }).ethereum,
    () => true,
  );

  // Nothing to connect to on a preview build, and connecting would only invite a transaction that cannot work.
  if (DEMO) {
    return (
      <span className="btn btn-sm is-static" title="This deployment replays a recorded chain. Nothing is live.">
        preview
      </span>
    );
  }

  if (!isConnected) {
    const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
    const here = typeof window !== "undefined" ? window.location.href : "https://tickrfun.gg";
    return (
      <span className="relative inline-block">
        <button
          className="btn btn-primary btn-sm"
          disabled={isPending || !injected}
          onClick={() => {
            if (!hasProvider) {
              setChooser((v) => !v);
              return;
            }
            connect({ connector: injected });
          }}
        >
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {(chooser || (error && !hasProvider)) && (
          <div className="wallet-chooser" role="dialog" aria-label="open in a wallet">
            <div className="label mb-2">no wallet found in this browser</div>
            <p className="text-muted text-[13px] mb-3">open this page inside your wallet app, where it can connect, or install a wallet extension on desktop.</p>
            <div className="flex flex-col gap-2">
              {WALLET_APPS.map((w) => (
                <a key={w.name} className="btn btn-sm w-full" href={w.open(here)} rel="noreferrer">
                  open in {w.name}
                </a>
              ))}
            </div>
            <p className="text-dim text-[12px] mt-3">or copy this page&apos;s link into your wallet&apos;s own browser.</p>
          </div>
        )}
        {error && hasProvider && <span className="text-danger text-[12px] ml-2">{error.message.slice(0, 80)}</span>}
      </span>
    );
  }
  if (chainId !== robinhoodChain.id) {
    return (
      <button className="btn btn-sm" disabled={switching} onClick={() => switchChain({ chainId: robinhoodChain.id })}>
        {switching ? "Switching…" : <>Switch to <span className="cap">Robinhood Chain</span></>}
      </button>
    );
  }
  return (
    <button className="btn btn-sm num" onClick={() => disconnect()} title="Disconnect">
      {shortAddr(address)}
    </button>
  );
}
