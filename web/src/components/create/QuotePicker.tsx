"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress, type Address } from "viem";
import { sameAddr } from "@/lib/addresses";
import { TokenLogo } from "../TokenLogo";
import { StockLogo } from "../StockLogo";

export type PickKind = "market" | "coin" | "name" | "stock";
export type PickItem = {
  kind: PickKind;
  address: Address;
  symbol: string;
  name: string;
  logo?: string;
  /** the figure on the right, and the word under it */
  figure?: string;
  figureNote?: string;
  disabledReason?: string;
  /** small chips after the kind, e.g. the venues a chain token trades on */
  tags?: string[];
  /** larger sorts first inside its kind */
  weight: number;
};

const KIND_LABEL: Record<PickKind, string> = {
  market: "chain token",
  coin: "tickr coin",
  name: "invented name",
  stock: "Stock Token",
};
const KIND_ORDER: Record<PickKind, number> = {
  market: 0,
  coin: 1,
  name: 2,
  stock: 3,
};

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * One list of everything a coin can be priced in that is not ETH or USDG: coins launched here, names creators
 * invented, and the Stock Tokens with a price feed. Typing filters by symbol, name or address; a full address that
 * is not in the list is handed back to the form, which says what it is.
 */
export function QuotePicker({
  items,
  loading,
  selected,
  onSelect,
  onAddress,
}: {
  items: PickItem[];
  loading: boolean;
  selected?: Address;
  onSelect: (item: PickItem) => void;
  onAddress: (address: string) => void;
}) {
  const [q, setQ] = useState("");
  // a dropdown: the list opens when the field is used and closes on a pick or a click elsewhere
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const picked = selected
    ? items.find((it) => sameAddr(it.address, selected))
    : undefined;
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        b.weight - a.weight ||
        a.symbol.localeCompare(b.symbol),
    );
    if (!needle) return sorted;
    return sorted.filter(
      (it) =>
        it.symbol.toLowerCase().includes(needle) ||
        it.name.toLowerCase().includes(needle) ||
        it.address.toLowerCase().includes(needle),
    );
  }, [items, needle]);

  function onChange(v: string) {
    setQ(v);
    const t = v.trim();
    if (!isAddress(t)) return;
    const hit = items.find((it) => sameAddr(it.address, t as Address));
    if (hit && !hit.disabledReason) {
      onSelect(hit);
      setQ("");
      setOpen(false);
    } else if (!hit) {
      onAddress(t);
    }
  }

  return (
    <div className="qp" ref={box} data-open={open}>
      <input
        className="qp-search"
        value={q}
        onChange={(e) => {
          setOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        placeholder={
          picked
            ? `${picked.symbol} picked. type to change it`
            : "type a name, a ticker or an address"
        }
        aria-label="find a quote asset"
        autoComplete="off"
        spellCheck={false}
      />
      {!open && picked && (
        <button
          type="button"
          className="qp-row"
          data-selected="true"
          onClick={() => setOpen(true)}
        >
          {picked.kind === "stock" ? (
            <StockLogo ticker={picked.symbol} size={32} />
          ) : (
            <TokenLogo src={picked.logo} symbol={picked.symbol} size={32} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              <span className="num font-semibold text-white">
                {picked.symbol}
              </span>
              {picked.name && picked.name !== picked.symbol && (
                <span className="text-muted"> {picked.name}</span>
              )}
            </span>
            <span className="flex items-center gap-2 mt-0.5">
              <span className="num text-dim text-[12px]">
                {short(picked.address)}
              </span>
              <span className="qp-kind">{KIND_LABEL[picked.kind]}</span>
            </span>
          </span>
          <span className="qp-fig text-dim text-[13px]">change</span>
        </button>
      )}
      {open && (
        <>
          <div className="qp-head">
            <span>what your coin can be priced in</span>
            <span className="num">
              {loading && items.length === 0
                ? "loading"
                : `${shown.length} of ${items.length}`}
            </span>
          </div>
          <div className="qp-list" role="listbox">
            {shown.length === 0 && !loading && (
              <div className="qp-empty">
                {needle
                  ? "nothing matches. paste an address to see what it is."
                  : "nothing to pair with yet."}
              </div>
            )}
            {shown.map((it) => {
              const isSel = !!selected && sameAddr(selected, it.address);
              return (
                <button
                  key={`${it.kind}:${it.address}`}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  className="qp-row"
                  data-selected={isSel}
                  disabled={!!it.disabledReason}
                  title={it.disabledReason}
                  onClick={() => {
                    onSelect(it);
                    setQ("");
                    setOpen(false);
                  }}
                >
                  {it.kind === "stock" ? (
                    <StockLogo ticker={it.symbol} size={32} />
                  ) : (
                    <TokenLogo src={it.logo} symbol={it.symbol} size={32} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="num font-semibold text-white">
                        {it.symbol}
                      </span>
                      {it.name && it.name !== it.symbol && (
                        <span className="text-muted"> {it.name}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 mt-0.5">
                      <span className="num text-dim text-[12px]">
                        {short(it.address)}
                      </span>
                      <span className="qp-kind">{KIND_LABEL[it.kind]}</span>
                      {it.tags?.map((t) => (
                        <span key={t} className="qp-kind num">
                          {t}
                        </span>
                      ))}
                    </span>
                  </span>
                  {(it.figure || it.disabledReason) && (
                    <span className="qp-fig">
                      <span className="num block text-white">
                        {it.disabledReason ? "no feed" : it.figure}
                      </span>
                      {!it.disabledReason && it.figureNote && (
                        <span className="block text-dim text-[12px]">
                          {it.figureNote}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
