/// <reference types="bun-types" />
/**
 * CS16 Server Bridge — WebSocket ⇄ UDP proxy + HLDS supervisor.
 *
 * - Spawns the real Counter-Strike 1.6 dedicated server (HLDS, 32-bit).
 *   Two run modes:
 *     · NATIVE  (QEMU env unset/empty): runs ./hlds_linux directly. Use this
 *       on x86_64 hosts (Render Docker, any VPS) with 32-bit libs installed
 *       (debian: libc6-i386).
 *     · QEMU (QEMU env set): runs HLDS under qemu-i386 user emulation with
 *       an i386 sysroot — used on ARM hosts (the dev sandbox).
 * - Bridges every browser WebSocket connection (binary frames) to its own
 *   UDP socket against HLDS at 127.0.0.1:27015.
 * - Exposes /health for the web launcher (CORS enabled, so the frontend may
 *   live on another origin, e.g. Cloudflare Pages). Server logs remain in
 *   the deployment platform's dashboard and are never exposed over HTTP.
 *
 * All paths are configurable via env so the same file runs in the sandbox,
 * in Docker and on a VPS unchanged.
 */
import dgram from "node:dgram";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

function readIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const PORT = readIntegerEnv("PORT", 3010, 1, 65535);
const HLDS_DIR = process.env.HLDS_DIR || "/home/z/my-project/hlds-ns-root/opt/steam/hlds";
// Run-mode selection for the 32-bit HLDS binary:
//   - QEMU env set to a path      → qemu-i386 user emulation with SYSROOT.
//   - QEMU env set to "" (empty)  → force native 32-bit (x86_64 Docker/VPS).
//   - QEMU env UNSET              → auto-detect: if the sandbox qemu binary
//     exists, use it (the sandbox may report x64 while still being unable to
//     exec i386 ELFs directly); otherwise native.
const QEMU_CANDIDATE = "/home/z/my-project/compat/qemu11/usr/bin/qemu-i386";
const QEMU_FORCE_NATIVE = process.env.QEMU !== undefined && process.env.QEMU === "";
let QEMU = process.env.QEMU || "";
if (process.env.QEMU === undefined && !QEMU) {
  try {
    if (existsSync(QEMU_CANDIDATE)) QEMU = QEMU_CANDIDATE;
  } catch {}
}
const SYSROOT = process.env.SYSROOT || "/home/z/my-project/compat/i386";
const HLDS_PORT = readIntegerEnv("HLDS_PORT", 27015, 1, 65535);
const HLDS_MAP = process.env.HLDS_MAP || "de_dust2";
if (!/^[A-Za-z0-9_-]+$/.test(HLDS_MAP)) {
  throw new Error("HLDS_MAP must contain only letters, digits, '_' or '-'");
}
const HLDS_MAXPLAYERS = readIntegerEnv("HLDS_MAXPLAYERS", 16, 1, 32);
const HLDS_BOT_QUOTA = readIntegerEnv("HLDS_BOT_QUOTA", 9, 0, 32);
if (HLDS_BOT_QUOTA > HLDS_MAXPLAYERS) {
  throw new Error("HLDS_BOT_QUOTA cannot exceed HLDS_MAXPLAYERS");
}
const LOG_FILE = process.env.HLDS_LOG_FILE || "/home/z/my-project/hlds-logs/hlds-supervised.log";
const ALLOWED_ORIGINS = new Set(
  (process.env.BRIDGE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
if (process.env.NODE_ENV === "production" && ALLOWED_ORIGINS.size === 0) {
  throw new Error("BRIDGE_ALLOWED_ORIGINS must list at least one frontend origin in production");
}

function isAllowedOrigin(origin: string | null): boolean {
  // Empty configuration keeps local/single-origin development working. In a
  // split deployment BRIDGE_ALLOWED_ORIGINS must contain the frontend origin.
  if (ALLOWED_ORIGINS.size === 0) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin.replace(/\/+$/, ""));
}

try {
  mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {}

let hldsChild: ReturnType<typeof Bun.spawn> | null = null;
let hldsStarts = 0;
let nativeFailures = 0;
let packetsIn = 0; // browser → HLDS
let packetsOut = 0; // HLDS → browser
const startedAt = Date.now();

function log(...args: unknown[]) {
  const line = `[cs16-server ${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    // Append (Bun.write would clobber the file, mixing in HLDS output).
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

/** Quick UDP liveness probe (A2S_INFO without challenge). */
function probeHlds(timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on("message", () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    sock.send(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54, 0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20, 0x45, 0x6e, 0x67, 0x69, 0x6e, 0x65, 0x20, 0x51, 0x75, 0x65, 0x72, 0x79, 0x00]),
      HLDS_PORT,
      "127.0.0.1",
    );
  });
}

function spawnHlds(): void {
  if (hldsChild) return;
  hldsStarts++;
  log(`spawning HLDS (attempt #${hldsStarts}, mode: ${QEMU ? "qemu" : "native"})`);
  const hldsArgs = [
    "./hlds_linux",
    "-game", "cstrike",
    "-insecure",
    "-nobreakpad",
    "-console",
    "+sv_lan", "1",
    "+ip", "127.0.0.1",
    "+map", HLDS_MAP,
    "-port", String(HLDS_PORT),
    "+maxplayers", String(HLDS_MAXPLAYERS),
    "+exec", "server.cfg",
  ];
  const argv = QEMU ? [QEMU, "-L", SYSROOT, ...hldsArgs] : hldsArgs;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      cwd: HLDS_DIR,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LD_LIBRARY_PATH: HLDS_DIR },
    });
  } catch (error) {
    log("HLDS spawn failed", error);
    hldsChild = null;
    setTimeout(() => {
      void ensureHlds(true);
    }, 4000);
    return;
  }
  hldsChild = child;

  const appendLog = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          appendFileSync(LOG_FILE, line + "\n");
        } catch {}
        // Render only exposes the container's stdout/stderr in its dashboard.
        // Keep the local file too, but mirror HLDS output there for diagnosis.
        console.log(`[hlds] ${line}`);
      }
    }
  };
  void appendLog(child.stdout as ReadableStream<Uint8Array>);
  void appendLog(child.stderr as ReadableStream<Uint8Array>);

  child.exited.then((code) => {
    log(`HLDS exited with code ${code}`);
    hldsChild = null;
    // Safety net: if native 32-bit execution keeps failing on a host that
    // still has the sandbox qemu available, fall back to qemu emulation.
    if (!QEMU && !QEMU_FORCE_NATIVE && code !== 0) {
      nativeFailures++;
      if (nativeFailures >= 2) {
        try {
          if (existsSync(QEMU_CANDIDATE)) {
            QEMU = QEMU_CANDIDATE;
            log(`native HLDS failed ${nativeFailures}× — falling back to qemu emulation`);
          }
        } catch {}
      }
    }
    setTimeout(() => {
      void ensureHlds(true);
    }, 4000);
  });
}

async function ensureHlds(forceSpawn = false): Promise<void> {
  const alive = await probeHlds();
  if (alive) {
    log("HLDS already answering on UDP 27015");
    return;
  }
  if (forceSpawn || !hldsChild) spawnHlds();
}

/** ws → udp mapping */
const wsToUdp = new Map<object, dgram.Socket>();

async function main() {
  await ensureHlds(true);
  // periodic health check
  setInterval(() => {
    void (async () => {
      const alive = await probeHlds();
      if (!alive && !hldsChild) spawnHlds();
    })();
  }, 15000);

  Bun.serve({
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      if (origin && !isAllowedOrigin(origin)) {
        return new Response("Origin not allowed", { status: 403 });
      }

      // CORS so a frontend on another origin (Cloudflare Workers) can poll
      // /health. Echo the validated origin instead of using a wildcard.
      const cors = {
        "access-control-allow-origin": origin || "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname === "/health") {
        const alive = await probeHlds();
        return Response.json(
          {
            hlds: alive,
            starts: hldsStarts,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            clients: wsToUdp.size,
            packetsIn,
            packetsOut,
            map: HLDS_MAP,
            bots: HLDS_BOT_QUOTA,
            maxPlayers: HLDS_MAXPLAYERS,
          },
          { status: alive ? 200 : 503, headers: cors },
        );
      }
      // Logs stay in the Render dashboard. Never expose HLDS output publicly.
      if (url.pathname === "/logs") return new Response("Not found", { status: 404 });

      // WebSocket upgrade for the game tunnel. Browsers always send Origin;
      // reject an originless upgrade when an allow-list is configured.
      if (ALLOWED_ORIGINS.size > 0 && !origin) {
        return new Response("Origin required", { status: 403 });
      }
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("CS16 bridge. Use WebSocket.", { status: 426 });
    },
    websocket: {
      open(ws) {
        log("client ws connected");
        const sock = dgram.createSocket("udp4");
        sock.on("message", (msg) => {
          packetsOut++;
          try {
            ws.send(new Uint8Array(msg));
          } catch (e) {
            log("ws send failed", e);
          }
        });
        sock.on("error", (e) => log("udp sock error", e));
        wsToUdp.set(ws, sock);
      },
      message(ws, msg) {
        const sock = wsToUdp.get(ws);
        if (!sock) return;
        const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
        try {
          sock.send(data, HLDS_PORT, "127.0.0.1");
          packetsIn++;
        } catch (e) {
          log("udp send failed", e);
        }
      },
      close(ws) {
        const sock = wsToUdp.get(ws);
        if (sock) {
          try {
            sock.close();
          } catch {}
          wsToUdp.delete(ws);
        }
        log("client ws disconnected");
      },
    },
  });

  log(`bridge listening on :${PORT}`);
}

void main();
