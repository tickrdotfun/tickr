"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { robinhoodChain } from "@/lib/chain";
import { DEMO } from "@/lib/demoTransport";
import { shortAddr } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

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
    return (
      <button className="btn btn-primary btn-sm" disabled={isPending || !injected} onClick={() => connect({ connector: injected })}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
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
