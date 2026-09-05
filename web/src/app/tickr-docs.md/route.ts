import { llmsFull } from "@/lib/llms";

export const dynamic = "force-static";

/** The same corpus as /llms-full.txt, but served as a file so a browser saves it instead of showing it. */
export function GET() {
  return new Response(llmsFull("https://tickr-zeta.vercel.app"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'attachment; filename="tickr-docs.md"',
    },
  });
}
