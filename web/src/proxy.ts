import { NextResponse, type NextRequest } from "next/server";
import { SOON } from "@/lib/siteMode";

/**
 * Before launch, the domain shows the landing and nothing else. Every page path renders the landing; the data
 * routes (the api, the llms text, the markdown mirrors) answer 404; the static assets the landing needs still
 * serve. On the full site this file does nothing.
 */
const ASSET = /^\/(brand|logos)\/|^\/(favicon|icon|apple-icon|opengraph-image|twitter-image)[^/]*$/;

/** The brand pages are working tools for screenshots, not part of the site: they only render off Vercel production. */
const BRAND_PAGE = /^\/brand(\/[a-z-]+)?$/;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (BRAND_PAGE.test(pathname) && process.env.VERCEL_ENV === "production") return new NextResponse(null, { status: 404 });
  if (!SOON) return NextResponse.next();
  if (pathname === "/" || ASSET.test(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/") || /\.(txt|md|json)$/.test(pathname) || /\/raw$/.test(pathname)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.rewrite(new URL("/", request.url));
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
