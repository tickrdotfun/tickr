import Link from "next/link";
import { ATTRIBUTION, SOCIALS } from "@/lib/constants";
import { EXPLORER } from "@/lib/chain";
import { TickrIcon } from "./Mark";
import { RainbowRule } from "./RainbowRule";

export function Footer() {
  return (
    <footer className="mt-16">
      <div className="measure pt-8">
        <RainbowRule width="full" />
      </div>
      <div className="measure py-8 flex flex-col sm:flex-row gap-4 sm:items-center text-muted">
        <span className="pt-2">
          <TickrIcon size={20} />
        </span>
        <em className="text-[14px]">{ATTRIBUTION}</em>
        <span className="sm:ml-auto flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
          {/* the chain, as its mark rather than a line of text */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/robinhood/Robinhood_Avatar.jpg"
            alt="Robinhood Chain"
            title="Robinhood Chain"
            className="footer-chain-mark"
          />
          <Link href="/docs">docs</Link>
          <a href={SOCIALS.x.href} target="_blank" rel="noreferrer" title={SOCIALS.x.handle}>
            {SOCIALS.x.label}
          </a>
          <a href={EXPLORER} target="_blank" rel="noreferrer">
            explorer
          </a>
          {/* last, so it sits at the right end of the row */}
          <a href="https://github.com/tickrdotfun/tickr" target="_blank" rel="noreferrer">
            code
          </a>
          <Link href="/terms">terms</Link>
        </span>
      </div>
    </footer>
  );
}
