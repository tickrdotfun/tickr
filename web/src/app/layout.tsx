import type { Metadata } from "next";
import { Source_Serif_4, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Backdrop } from "@/components/art/Backdrop";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { NotDeployedBanner } from "@/components/NotDeployedBanner";
import { ViewFade } from "@/components/motion/ViewFade";
import { AnchorScroll } from "@/components/motion/AnchorScroll";
import { ComingSoon } from "@/components/ComingSoon";
import { SOON } from "@/lib/siteMode";

// Source Serif 4 is reserved for the mark (branding2/BRANDING.md §2). It is not used for running text.
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
  display: "swap",
});

// UI family: Instrument Sans, a modern neutral grotesque. Deliberate departure from BRANDING.md §4,
// which asked for the serif as chrome; the serif now does logo duty only, so the mark carries the character.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "tickr",
  description: "Pair anything on Robinhood Chain. Launch a coin priced against ETH, USDG, a Stock Token, another coin, or a ticker you invent.",
  openGraph: { title: "tickr: pair anything on Robinhood Chain", siteName: "tickr" },
  twitter: { card: "summary_large_image", site: "@tickrdotfun_rh", creator: "@tickrdotfun_rh" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // the domain, before launch: the hero and nothing else, on the same ground. every path renders this (see proxy.ts)
  if (SOON) {
    return (
      <html lang="en" className={`${sourceSerif.variable} ${instrumentSans.variable} h-full antialiased`}>
        <body className="min-h-full flex flex-col">
          <Backdrop />
          <main className="measure flex-1 soon-main">
            <ComingSoon />
          </main>
        </body>
      </html>
    );
  }
  return (
    <html lang="en" className={`${sourceSerif.variable} ${instrumentSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <Backdrop />
          <AnchorScroll />
        <Header />
          <NotDeployedBanner />
          <main className="measure flex-1 pt-10 pb-16">
            <ViewFade>{children}</ViewFade>
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
