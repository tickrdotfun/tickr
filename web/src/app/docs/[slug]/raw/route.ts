import { ALL_DOCS, docBySlug, rawDoc } from "@/lib/docs";

export const dynamic = "force-static";

export function generateStaticParams() {
  return ALL_DOCS.map((d) => ({ slug: d.slug }));
}

/** One page's markdown, as authored. Reachable as /docs/<slug>.md through the rewrite in next.config.ts. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = docBySlug(slug);
  if (!entry) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(rawDoc(entry), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
