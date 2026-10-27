/**
 * Sonda de la cadena de input del motor (CS 1.6 web port).
 *
 * 1) Imprime cvars de entrada: sensitivity, m_ignore, m_yaw, m_pitch, lookstrafe
 * 2) +right 1.2 s  → ¿gira la vista? (ruta de ángulos pura, sin ratón)
 * 3) +forward 1.2 s → ¿se mueve el personaje? (ruta de movimiento)
 * 4) developer 1 + movimiento real desbloqueado → ¿el motor loguea deltas?
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9337;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-look";
const SHOT = (n) => `/home/z/my-project/scripts/probe_${n}.png`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true }, timeoutMs);
    return r?.result?.value;
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

let CDP_REF = null;
function engineTail(cdp, n = 14) {
  return cdp.consoleLines
    .filter((l) => l.includes("cs16-engine"))
    .slice(-n)
    .map((l) => l.replace(/^.*cs16-engine\]\s*/, ""))
    .join(" | ");
}

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

    await cdp.send("Page.navigate", { url: `${TARGET}?t=${Date.now()}${process.env.LOOKFLAGS || ""}` });
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
    console.log("[2] joined:", joined);
    for (const [k, code, vk, t] of [["5","Digit5",53,"5"],["5","Digit5",53,"5"],["1","Digit1",49,"1"]]) {
      await pressKey(cdp, k, code, vk, t);
      await sleep(5000);
    }
    Bun.spawnSync(["python3", "/home/z/my-project/scripts/rcon.py", "sv_restart 1"], { stdout: "pipe", stderr: "pipe" });
    await sleep(13000);

    const cmd = (s) => cdp.eval(`window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString(${JSON.stringify(s)})`);

    // estado del FS del motor y del contexto GL
    const fsProbe = await cdp.eval(`(() => {
      try {
        const h = window.__cs16engine;
        const FS = h.engine.em.FS;
        const st = (p) => { try { const s = FS.analyzePath(p); if (!s.exists) return null; const i = FS.stat(p); return { size: i.size }; } catch (e) { return { err: String(e).slice(0, 40) }; } };
        const c = document.getElementById('canvas');
        const gl = c.getContext('webgl2');
        return {
          dust2: st('cstrike/maps/de_dust2.bsp'),
          aztec: st('cstrike/maps/de_aztec.bsp'),
          gfx: st('cstrike/gfx.wad'),
          ctxLost: gl ? gl.isContextLost() : 'no-gl',
          cw: c.width, ch: c.height,
        };
      } catch (e) { return { err: String(e).slice(0, 80) }; }
    })()`);
    console.log("[FS/GL]", JSON.stringify(fsProbe));

    // (1) cvars de entrada
    for (const c of ["sensitivity", "m_ignore", "m_yaw", "m_pitch", "lookstrafe", "cl_forwardspeed"]) {
      await cmd(c);
      await sleep(700);
    }
    const cvars = cdp.consoleLines
      .filter((l) => /"(sensitivity|m_ignore|m_yaw|m_pitch|lookstrafe|cl_forwardspeed)" is/.test(l))
      .slice(-8);
    console.log("[3] cvars:");
    for (const l of cvars) console.log("   ", l.replace(/^.*cs16-engine\]\s*/, "").slice(0, 120));

    // (2) +right
    await cdp.screenshot(SHOT("p0"));
    await cmd("+right");
    await sleep(1200);
    await cmd("-right");
    await sleep(600);
    await cdp.screenshot(SHOT("p1"));
    console.log("[4] +right aplicado (compara probe_p0 vs probe_p1)");

    // (3) +forward
    await cmd("+forward");
    await sleep(1200);
    await cmd("-forward");
    await sleep(600);
    await cdp.screenshot(SHOT("p2"));
    console.log("[5] +forward aplicado (compara probe_p1 vs probe_p2)");

    // (4) developer + ratón real desbloqueado
    await cmd("developer 1");
    await sleep(500);
    await pressKey(cdp, "Escape", "Escape", 27, "");
    await sleep(600);
    for (let i = 0; i < 20; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: box.x - 200 + i * 20, y: box.y, buttons: 0,
      });
      await sleep(60);
    }
    await sleep(900);
    await cdp.screenshot(SHOT("p3"));
    console.log("[6] tras developer 1 + ratón real desbloqueado, log del motor:");
    console.log("   ", engineTail(cdp, 16));
    console.log("DONE");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  if (CDP_REF) {
    for (const l of CDP_REF.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-10))
      console.error(" ", l);
  }
  process.exit(1);
});
