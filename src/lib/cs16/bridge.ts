/**
 * Bridge URL helpers.
 *
 * Two deployment modes:
 *  - Same-origin (sandbox preview / single VPS): the frontend talks to its own
 *    origin and the gateway (Caddy) forwards with ?XTransformPort=3010.
 *  - Split (Cloudflare frontend + Render bridge): set
 *    NEXT_PUBLIC_CS16_BRIDGE_URL=wss://cs16-xxx.onrender.com at build time and
 *    every helper returns the absolute bridge URL instead.
 */
export function bridgeBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_CS16_BRIDGE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return ""; // same-origin
}

/** Absolute URL for the bridge health endpoint. */
export function bridgeHttpUrl(pathAndQuery: string): string {
  const base = bridgeBaseUrl();
  if (base) {
    // NEXT_PUBLIC_CS16_BRIDGE_URL is normally a wss:// URL because the game
    // tunnel is WebSocket-only. HTTP probes must use the corresponding origin.
    const httpBase = base.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
    return `${httpBase}${pathAndQuery}`;
  }
  const separator = pathAndQuery.includes("?") ? "&" : "?";
  return `${pathAndQuery}${separator}XTransformPort=3010`;
}

/** WebSocket URL for the game tunnel. */
export function bridgeWsUrl(): string {
  const base = bridgeBaseUrl();
  if (base) {
    return base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/?XTransformPort=3010`;
}

/**
 * URL for big game assets (/assets/**).
 *
 * Same-origin deployments serve them from the app's own /assets route
 * (disk streaming). The Cloudflare Worker deployment copies the same files
 * into Worker Static Assets, so no external URL is required by default.
 * Alternatively, set NEXT_PUBLIC_ASSETS_BASE_URL to a public R2 bucket
 * (custom domain or r2.dev endpoint) to serve them from R2, e.g.
 *   NEXT_PUBLIC_ASSETS_BASE_URL=https://assets.example.com
 * R2 public endpoints natively support HTTP Range for resumable downloads
 * (configure a CORS policy on the bucket).
 */
export function assetUrl(pathWithLeadingSlash: string): string {
  const base = process.env.NEXT_PUBLIC_ASSETS_BASE_URL;
  if (base) return `${base.replace(/\/+$/, "")}${pathWithLeadingSlash}`;
  return pathWithLeadingSlash;
}
