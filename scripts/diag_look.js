/**
 * Diagnóstico de la cadena de mirada (CS 1.6 web port).
 *
 * 1) Enumera listeners reales (CDP DOMDebugger) en canvas/document/window
 *    → ¿dónde registró SDL2 su mousemove/pointerlockchange?
 * 2) Imprime m_rawinput vía consola del motor (Cmd_ExecuteString).
 * 3) Test DESBLOQUEADO: Esc → mover cursor real (CDP) → ¿gira la vista?
 *    (prueba la vía absoluta SDL→motor sin pointer lock)
 * 4) Test BLOQUEADO: lock → mousemove virtual (rewriter) → ¿gira?
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9336;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-look";
const SHOT = (n) => `/home/z/my-project/scripts/diag_${n}.png`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    this.objects = new Map();
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
  async evalObj(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: false,
    });
    return r?.result?.objectId;
  }
  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" }, 12000);
    await Bun.write(path, Buffer.from(r.data, "base64"));
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

async function pressKey(cdp, key, code, vk, text) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    text, unmodifiedText: text,
  });
  await sleep(80);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

async function listenersOf(cdp, objectId, filterTypes = null) {
  try {
    const r = await cdp.send("DOMDebugger.getEventListeners", { objectId });
    const out = [];
    for (const l of r.listeners || []) {
      if (filterTypes && !filterTypes.includes(l.type)) continue;
      let src = "";
      const oid = l.handler?.objectId;
      if (oid) {
        try {
          const props = await cdp.send("Runtime.getProperties", { objectId: oid, ownProperties: false });
          src = (props.internalProperties || []).find((p) => p.name === "[[FunctionLocation]]")?.value?.description || "";
        } catch {}
      }
      out.push({
        t: l.type,
        cap: l.useCapture,
        line: l.lineNumber,
        col: l.columnNumber,
        desc: (l.handler?.description || "").slice(0, 110).replace(/\s+/g, " "),
        loc: src || `${l.scriptId}:${l.lineNumber}:${l.columnNumber}`,
      });
    }
    return out;
  } catch (e) {
    return [{ t: `ERR ${String(e).slice(0, 60)}` }];
  }
}

async function cdpMoves(cdp, x0, y, dx, steps = 16) {
  for (let i = 0; i < steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: x0 + Math.round((dx * i) / steps), y, buttons: 0,
    });
    await sleep(60);
  }
}

let CDP_REF = null;

async function main() {
  console.log("[1] chrome...");
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
    CDP_REF = cdp;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");

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
        onGame = await cdp.eval(`!!window.__cs16engine`, 12000);
      } catch { continue; }
    }
    if (!onGame) throw new Error("sin pantalla de juego");
    console.log("[2] game screen OK");

    const box = (await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)) || { x: 512, y: 320 };
    await trustedClick(cdp, box.x, box.y);
    await sleep(800);

    let joined = false;
    for (let i = 0; i < 36 && !joined; i++) {
      await sleep(5000);
      joined = cdp.consoleLines.some((l) => l.includes("conexión establecida"));
    }
    console.log("[3] joined:", joined);
    for (const [k, code, vk, t] of [["5","Digit5",53,"5"],["5","Digit5",53,"5"],["1","Digit1",49,"1"]]) {
      await pressKey(cdp, k, code, vk, t);
      await sleep(5000);
    }
    Bun.spawnSync(["python3", "/home/z/my-project/scripts/rcon.py", "sv_restart 1"], { stdout: "pipe", stderr: "pipe" });
    await sleep(13000);

    // ---- (1) listeners reales (con fuente) ----
    console.log("[4] listeners mouse/key (canvas, document, window, body):");
    for (const [name, expr] of [
      ["canvas", "document.getElementById('canvas')"],
      ["document", "document"],
      ["window", "window"],
      ["body", "document.body"],
    ]) {
      const oid = await cdp.evalObj(expr);
      const list = oid ? await listenersOf(cdp, oid, ["mousemove", "mousedown", "mouseup", "keydown", "pointerlockchange", "wheel"]) : [{ t: "(sin objectId)" }];
      console.log(`  ${name}: ${list.length}`);
      for (const l of list) console.log("    ", JSON.stringify(l));
    }

    // ---- (2) m_rawinput vía consola del motor ----
    await cdp.eval(`window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString('m_rawinput')`);
    await sleep(1200);
    const cvar = cdp.consoleLines.filter((l) => l.includes("m_rawinput")).slice(-2);
    console.log("[5] m_rawinput:", cvar.join(" | ") || "(sin respuesta)");

    // ---- (3) test DESBLOQUEADO ----
    await cdp.screenshot(SHOT("u0"));
    await pressKey(cdp, "Escape", "Escape", 27, "");
    await sleep(600);
    const unlocked = await cdp.eval(`!document.pointerLockElement`);
    console.log("[6] unlocked:", unlocked);
    await cdpMoves(cdp, box.x - 160, box.y, 320);
    await sleep(900);
    await cdp.screenshot(SHOT("u1"));

    // ---- (4) test BLOQUEADO con rewriter ----
    await trustedClick(cdp, box.x, box.y);
    await sleep(800);
    const locked = await cdp.eval(`!!document.pointerLockElement`);
    console.log("[7] re-locked:", locked);
    await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      window.__mv2 = [];
      c.addEventListener('mousemove', (e) => {
        if (window.__mv2.length < 300) window.__mv2.push([e.movementX|0, e.clientX|0]);
      }, true);
      window.__inject2 = (dx) => {
        const e = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(e, 'movementX', { value: dx });
        c.dispatchEvent(e);
      };
      return 1;
    })()`);
    await cdp.eval(`window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString('cl_showpos 1')`);
    await sleep(800);
    await cdp.screenshot(SHOT("l0"));
    for (let i = 0; i < 6; i++) { await cdp.eval(`__inject2(50)`); await sleep(120); }
    await sleep(900);
    await cdp.screenshot(SHOT("l1"));
    console.log("[8] __mv2:", JSON.stringify(await cdp.eval(`__mv2.slice(0, 8)`)));
    await cdp.eval(`window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString('status')`);
    await sleep(1500);
    console.log("[9] LOG MOTOR (últimas 40):");
    for (const l of cdp.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-40)) {
      console.log("   ", l.replace(/^.*cs16-engine\]\s*/, "").slice(0, 150));
    }
    console.log("DONE — compara diag_u0/u1 (desbloqueado) y diag_l0/l1 (bloqueado)");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  if (CDP_REF) {
    for (const l of CDP_REF.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-8))
      console.error(" ", l);
  }
  process.exit(1);
});
