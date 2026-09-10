"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { TickrMark } from "./Mark";
import { XIcon } from "./XIcon";
import { SOCIALS } from "@/lib/constants";
import { GlideIndicator, useGlider } from "./motion/Glide";

const NAV = [
  { href: "/", label: "Launches" },
  { href: "/create", label: "Create" },
] as const;

export function Header() {
  // null before the router has a path: nothing is marked active until it does, rather than throwing
  const path = usePathname() ?? "";
  const activeHref = NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href)))?.href ?? null;
  const { trackRef, indRef } = useGlider(activeHref);

  return (
    <header className="header-glass sticky top-0 z-20">
      <span className="header-sheen" aria-hidden="true" />
      <div className="measure header-row relative flex items-center">
        <Link href="/" className="header-mark no-underline hover:no-underline" aria-label="tickr home">
          <TickrMark size={48} buildIn blink drift />
        </Link>

        <nav ref={trackRef} className="glide-track header-nav-gap ml-auto flex items-center gap-6">
          <GlideIndicator indRef={indRef} />
          {NAV.map((n) => {
            const active = n.href === activeHref;
            return (
              <Link
                key={n.href}
                href={n.href}
                data-glide-active={active}
                className={`glide-item no-underline hover:no-underline pb-[3px] border-b border-transparent ${
                  active ? "text-white" : "text-muted hover:text-white"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {/* Official Robinhood Chain logo, used unmodified. */}
          <a
            href={SOCIALS.x.href}
            target="_blank"
            rel="noreferrer"
            className="header-x no-underline hover:no-underline"
            aria-label={`tickr on X, ${SOCIALS.x.handle}`}
            title={SOCIALS.x.handle}
          >
            <XIcon size={15} />
          </a>
          <span className="chain-pill">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/robinhood/Robinhood_Avatar.jpg" alt="" className="chain-pill-mark" />
            <span className="cap">Robinhood Chain</span>
          </span>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
