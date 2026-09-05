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
          {/* the code, as GitHub's own mark; last but one, so it sits near the right end of the row */}
          <a href="https://github.com/tickrdotfun/tickr" target="_blank" rel="noreferrer" title="the code on GitHub" aria-label="the code on GitHub" className="inline-flex">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          <Link href="/terms">terms</Link>
        </span>
      </div>
    </footer>
  );
}
