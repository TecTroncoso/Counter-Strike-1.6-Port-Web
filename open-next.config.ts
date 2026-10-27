import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext → Cloudflare Workers adapter config.
 * Default (no incremental cache / no queue) is enough for this app:
 * the launcher is mostly client-side and there are no ISR-heavy pages.
 */
export default defineCloudflareConfig();
