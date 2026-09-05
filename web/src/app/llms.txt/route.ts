import { llmsIndex } from "@/lib/llms";

export const dynamic = "force-static";

/** The llms.txt convention: a short index an agent can read before deciding what to fetch. */
export function GET() {
  return new Response(llmsIndex("https://tickr-zeta.vercel.app"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
