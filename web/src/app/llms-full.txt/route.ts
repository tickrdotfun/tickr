import { llmsFull } from "@/lib/llms";

export const dynamic = "force-static";

/** Every page, concatenated, for pasting whole into a model. */
export function GET() {
  return new Response(llmsFull("https://tickr-zeta.vercel.app"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
