/**
 * Registra TODAS las altas de listeners de ratón/teclado desde el inicio de la
 * página (wrapping de addEventListener) para ver quién registra qué y dónde.
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9339;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-look";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
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
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true }, timeoutMs);
    return r?.result?.value;
  }
}

async function waitTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no page target found");
}

async function trustedClick(cdp, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1,
      buttons: type === "mousePressed" ? 1 : 0,
    });
    await sleep(80);
  }
}

const INIT = `
(() => {
  const orig = EventTarget.prototype.addEventListener;
  window.__reg = [];
  const TYPES = new Set(["mousemove","mousedown","mouseup","keydown","pointerlockchange","wheel","mouseenter","mouseleave"]);
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    try {
      if (TYPES.has(type)) {
        let tgt = "otro";
        try {
          if (this === window) tgt = "window";
          else if (this === document) tgt = "document";
          else if (this === document.body) tgt = "body";
          else if (this && this.tagName) tgt = this.tagName.toLowerCase() + (this.id ? "#" + this.id : "");
        } catch {}
        let src = "";
        try { src = (typeof fn === "function" ? Function.prototype.toString.call(fn) : String(fn)).slice(0, 200); } catch {}
        window.__reg.push({ t: type, tgt, cap: !!(typeof opts === "object" ? opts && opts.capture : opts), src });
      }
    } catch {}
    return orig.call(this, type, fn, opts);
  };
})();`;

async function main() {
  const proc = Bun.spawn([
    CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`,
    "--window-size=1024,640", `--user-data-dir=${PROFILE}`, "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });

  try {
    const wsUrl = await waitTarget();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });

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
      try {
        onGame = await cdp.eval(`(() => { const c = document.getElementById('canvas'); return !!(c && c.offsetParent !== null); })()`, 12000);
      } catch { continue; }
    }
    if (!onGame) throw new Error("sin pantalla de juego");
    // esperar a que el motor termine de init SDL (main loop ya corre)
    await sleep(15000);

    const reg = await cdp.eval(`window.__reg || []`);
    console.log(`[registros de listeners: ${reg.length}]`);
    for (const r of reg) {
      console.log(`\n${r.t} → ${r.tgt}${r.cap ? " (capture)" : ""}`);
      console.log("   " + String(r.src).replace(/\s+/g, " ").slice(0, 190));
    }
    console.log("\nDONE");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
