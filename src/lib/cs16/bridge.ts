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

/** Absolute URL for bridge HTTP endpoints (health, logs). */
export function bridgeHttpUrl(pathAndQuery: string): string {
  return `${bridgeBaseUrl()}${pathAndQuery}`;
}

/** WebSocket URL for the game tunnel. */
export function bridgeWsUrl(): string {
  const base = bridgeBaseUrl();
  if (base) {
    return base.replace(/^http/, "ws");
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/?XTransformPort=3010`;
}

/**
 * URL for big game assets (/assets/**).
 *
 * Same-origin deployments serve them from the app's own /assets route
 * (disk streaming). Split deployments (Cloudflare frontend) set
 * NEXT_PUBLIC_ASSETS_BASE_URL to a public Cloudflare R2 bucket URL
 * (custom domain or r2.dev endpoint) that mirrors game-files/, e.g.
 *   NEXT_PUBLIC_ASSETS_BASE_URL=https://assets.example.com
 * R2 public endpoints natively support HTTP Range, so resumable downloads
 * keep working cross-origin (configure a permissive CORS policy on the bucket).
 */
export function assetUrl(pathWithLeadingSlash: string): string {
  const base = process.env.NEXT_PUBLIC_ASSETS_BASE_URL;
  if (base) return `${base.replace(/\/+$/, "")}${pathWithLeadingSlash}`;
  return pathWithLeadingSlash;
}
