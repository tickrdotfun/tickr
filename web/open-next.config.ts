import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

/**
 * The site on Cloudflare Workers. The incremental cache lives in KV rather than in a Worker's memory, which
 * does not survive between requests.
 */
export default defineCloudflareConfig({ incrementalCache: kvIncrementalCache });
