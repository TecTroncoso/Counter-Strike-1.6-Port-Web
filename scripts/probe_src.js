/**
 * Extrae el fuente del script del glue en las líneas donde están registrados
 * los handlers de ratón (scriptId 6, líneas ~12911/12921) para identificarlos.
 * Solo necesita llegar a la pantalla de juego (los listeners ya existen).
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9338;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-look";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.scripts = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === "Debugger.scriptParsed") {
        this.scripts.push(msg.params);
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

async function dumpAround(cdp, scriptId, line, col, ctx = 14) {
  try {
    const r = await cdp.send("Debugger.getScriptSource", { scriptId });
    const src = r.scriptSource;
    const lines = src.split("\n");
    console.log(`\n===== script ${scriptId} líneas ${line - ctx + 1}–${line + ctx} (col ${col}) [total ${lines.length} líneas, ${src.length} B] =====`);
    for (let i = Math.max(0, line - ctx); i <= Math.min(lines.length - 1, line + ctx); i++) {
      const mark = i === line ? ">>>" : "   ";
      console.log(`${mark} ${i + 1}: ${lines[i].slice(0, 220)}`);
    }
  } catch (e) {
    console.log(`script ${scriptId}: ERR ${String(e).slice(0, 80)}`);
  }
}

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
    await cdp.send("Debugger.enable");

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
    console.log("[ok] pantalla de juego — scripts cargados:", cdp.scripts.length);

    // listar scripts grandes (el glue wasm bundlado)
    const big = cdp.scripts
      .filter((s) => (s.endOffset || 0) > 200000)
      .map((s) => ({ id: s.scriptId, len: s.endOffset, url: (s.url || "(inline)").slice(0, 90) }));
    console.log("scripts grandes:", JSON.stringify(big, null, 1));

    // el listener estaba en scriptId "6" líneas 12911/12921 — dump
    await dumpAround(cdp, "6", 12910, 34);
    await dumpAround(cdp, "6", 12920, 36);
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
