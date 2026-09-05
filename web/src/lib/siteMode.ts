/**
 * "soon": the domain shows only the landing, with nothing else reachable. Set NEXT_PUBLIC_SITE_MODE=soon on the
 * Vercel project that carries the domain; the full site keeps deploying to its own project without it.
 */
export const SOON = process.env.NEXT_PUBLIC_SITE_MODE === "soon";
