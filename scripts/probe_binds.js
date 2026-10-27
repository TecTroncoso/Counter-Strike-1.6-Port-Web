/**
 * Probe: dump de TODOS los binds activos en el motor (bindlist) para
 * auditar qué teclas clásicas de CS 1.6 faltan tras CLASSIC_BINDS.
 * No hace join — los binds existen desde el boot del motor.
 *
 * Run: bun /home/z/my-project/scripts/probe_binds.js
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9339;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-binds";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CDP_REF = null;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        if (text) this.consoleLines.push(text);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }
  async eval(expression, timeoutMs = 15000) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      timeoutMs,
    );
    return r?.result?.value;
  }
}

async function waitTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no encontré el target CDP");
}

async function trustedClick(cdp, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1,
    });
    await sleep(80);
  }
}

async function main() {
  console.log("[1] chrome...");
  const proc = Bun.spawn(
    [
      CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`,
      "--window-size=1024,640", `--user-data-dir=${PROFILE}`, "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    const wsUrl = await waitTarget();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    const cdp = new CDP(ws);
    CDP_REF = cdp;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", { url: `${TARGET}?t=${Date.now()}` });
    await sleep(4000);

    let btn = null;
    for (let i = 0; i < 30 && !btn; i++) {
      await sleep(1000);
      btn = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /jugar/i.test(x.textContent));
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
    }
    if (!btn) throw new Error("botón JUGAR no encontrado");
    await trustedClick(cdp, btn.x, btn.y);

    let onGame = false;
    for (let i = 0; i < 45 && !onGame; i++) {
      await sleep(5000);
      try { onGame = await cdp.eval(`!!window.__cs16engine`, 12000); } catch {}
    }
    if (!onGame) throw new Error("no llegó a la pantalla de juego");
    console.log("[2] engine OK — esperando asentamiento (6 s)...");
    await sleep(6000); // las primeras consultas se pierden durante la init
    const KEYS = [
      "q", "z", "x", "c", "1", "2", "3", "4", "5", "6", "7",
      "8", "9", "0", "i", "v", "h",
    ];
    for (const k of KEYS) {
      await cdp.eval(
        `window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString(${JSON.stringify(`bind ${k}`)})`,
      );
      await sleep(150);
    }
    await sleep(1000);

    const lines = cdp.consoleLines.filter((l) => l.includes("cs16-engine"));
    console.log(`[3] RESPUESTAS (${lines.length} líneas):`);
    for (const l of lines) console.log("   ", l.replace(/^\[cs16-engine\]\s*/, "").slice(0, 90));
    console.log("DONE");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
