/**
 * E2E test: ¿gira la mirada con el ratón? (CS 1.6 web port)
 *
 * Hipótesis: SDL2 (emscripten) solo usa movementX si SU handler de
 * pointerlockchange se entera del lock. Ese handler se registra sobre el
 * CANVAS, pero el navegador dispara 'pointerlockchange' en document →
 * has_pointer_lock queda false → usa posición absoluta (congelada) →
 * mirada muerta.
 *
 * Protocolo:
 *   A) lock real (clic) + inyección sintética de movementX  → screenshot B
 *   B) re-sync sintético: canvas.dispatchEvent('pointerlockchange') →
 *      inyección de nuevo                                    → screenshot C
 *   pixel-diff A/B y B/C → si solo C cambia, el fix (re-sync) es la clave.
 *
 * Además: movimientos "reales" vía CDP Input.dispatchMouseEvent y registro
 * de movementX visto por la página (informativo).
 *
 * Run: bun /home/z/my-project/scripts/look_test.js
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9335;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-look";
const SHOT = (n) => `/home/z/my-project/scripts/look_${n}.png`;

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
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      timeoutMs,
    );
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
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
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

async function diffPng(a, b) {
  const [ba, bb] = await Promise.all([Bun.file(a).bytes(), Bun.file(b).bytes()]);
  if (ba.length !== bb.length) return { bytes: -1, lenA: ba.length, lenB: bb.length };
  let d = 0;
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) d++;
  return { bytes: d, lenA: ba.length, lenB: bb.length };
}

let CDP_REF = null;

function engineTail(cdp, n = 8) {
  return cdp.consoleLines
    .filter((l) => l.includes("cs16-engine"))
    .slice(-n)
    .map((l) => l.replace(/^.*cs16-engine\]\s*/, ""))
    .join(" | ");
}

async function main() {
  console.log("[1] launching chrome...");
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      `--remote-debugging-port=${PORT}`,
      "--window-size=1024,640",
      `--user-data-dir=${PROFILE}`,
      "about:blank",
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

    console.log("[2] navigating...");
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
    console.log("[3] clicking JUGAR", btn);
    await trustedClick(cdp, btn.x, btn.y);

    console.log("[4] waiting for game screen...");
    let onGame = false;
    for (let i = 0; i < 45 && !onGame; i++) {
      await sleep(5000);
      try {
        onGame = await cdp.eval(
          `!!window.__cs16engine`,
          12000,
        );
      } catch { continue; }
    }
    if (!onGame) throw new Error("no llegó a la pantalla de juego");
    console.log("[5] game screen OK");

    const box = (await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)) || { x: 512, y: 320 };
    await trustedClick(cdp, box.x, box.y);
    await sleep(800);
    console.log("[6] pointer locked:", await cdp.eval(`!!document.pointerLockElement`));

    console.log("[7] waiting for join...");
    let joined = false;
    for (let i = 0; i < 36 && !joined; i++) {
      await sleep(5000);
      joined = cdp.consoleLines.some((l) => l.includes("conexión establecida"));
      if (i % 4 === 3) console.log(`    ...${(i + 1) * 5}s`);
    }
    console.log("[8] joined:", joined);

    for (const [k, code, vk, t, wait] of [
      ["5", "Digit5", 53, "5", 4000],
      ["5", "Digit5", 53, "5", 4000],
      ["1", "Digit1", 49, "1", 7000],
    ]) {
      await pressKey(cdp, k, code, vk, t);
      await sleep(wait);
    }

    // ronda fresca para evitar pantallas de muerte/espectador
    const rcon = Bun.spawnSync(
      ["python3", "/home/z/my-project/scripts/rcon.py", "mp_buytime 15", "sv_restart 1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log("[rcon]", rcon.stdout.toString().trim().slice(0, 200) || rcon.stderr.toString().slice(0, 120));
    await sleep(13000);

    await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      window.__mv = [];
      c.addEventListener('mousemove', (e) => {
        if (window.__mv.length < 400) window.__mv.push([e.movementX|0, e.movementY|0, e.clientX|0, e.clientY|0]);
      }, true);
      window.__inject = (dx, dy) => {
        const e = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(e, 'movementX', { value: dx });
        Object.defineProperty(e, 'movementY', { value: dy });
        c.dispatchEvent(e);
      };
      window.__plsync = () => { c.dispatchEvent(new Event('pointerlockchange')); return 'synced'; };
      return 'instrumented';
    })()`);

    // ronda de calibración: nada debe moverse
    await cdp.eval(`(() => {
      window.__sdlprobe = () => {
        try {
          const h = window.__cs16engine;
          if (!h) return { err: 'no handle' };
          const em = h.engine && h.engine.em;
          const M = em && (em.Module || em);
          if (!M) return { err: 'no module' };
          const path =
            (typeof M['_SDL_SetRelativeMouseMode'] === 'function' && 'Module._') ||
            (typeof em.wasmExports?.SDL_SetRelativeMouseMode === 'function' && 'wasmExports') ||
            (typeof em.asm?.SDL_SetRelativeMouseMode === 'function' && 'asm') ||
            'NINGUNA';
          return { path };
        } catch (e) { return { err: String(e) }; }
      };
      return 'probe ready';
    })()`);

    await cdp.screenshot(SHOT("0"));
    await sleep(1500);
    console.log("[SDL probe inicial]:", JSON.stringify(await cdp.eval(`__sdlprobe()`)));

    // ---------- FASE A: inyección SIN re-sync ----------
    console.log("[A] inject movementX=300 sin plsync...");
    for (let i = 0; i < 6; i++) { await cdp.eval(`__inject(50, 0)`); await sleep(120); }
    await sleep(800);
    await cdp.screenshot(SHOT("A"));
    console.log("[SDL probe tras A]:", JSON.stringify(await cdp.eval(`__sdlprobe()`)));
    console.log("    engine tail:", engineTail(cdp));

    // ---------- FASE B: setRelativeMouse(true) directo + inyección ----------
    console.log("[B] setRelativeMouse(true) directo + inject...");
    await cdp.eval(`__cs16engine && __cs16engine.setRelativeMouse(true)`);
    await sleep(300);
    console.log("[SDL probe tras set(true)]:", JSON.stringify(await cdp.eval(`__sdlprobe()`)));
    for (let i = 0; i < 6; i++) { await cdp.eval(`__inject(50, 0)`); await sleep(120); }
    await sleep(800);
    await cdp.screenshot(SHOT("B"));
    console.log("    engine tail:", engineTail(cdp));

    // ---------- FASE C: movimientos "reales" CDP tras el sync ----------
    console.log("[C] CDP dispatchMouseEvent mouseMoved dx=+320 tras sync...");
    const cx = box.x, cy = box.y;
    for (let i = 0; i < 16; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - 160 + i * 20, y: cy, buttons: 0 });
      await sleep(60);
    }
    await sleep(800);
    await cdp.screenshot(SHOT("C"));
    const mvInfo = await cdp.eval(`({
      n: __mv.length,
      first: __mv.slice(0, 4),
      last: __mv.slice(-6),
      nonZeroMvX: __mv.filter(m => m[0] !== 0).length,
      frozenClientX: __mv.length > 1 && __mv[0][2] === __mv[__mv.length-1][2],
    })`);
    console.log("    __mv:", JSON.stringify(mvInfo));

    const d0A = await diffPng(SHOT("0"), SHOT("A"));
    const dAB = await diffPng(SHOT("A"), SHOT("B"));
    const dBC = await diffPng(SHOT("B"), SHOT("C"));
    console.log("RESULTADOS:");
    console.log("  diff 0→A (inyección):          ", JSON.stringify(d0A));
    console.log("  diff A→B (setRelative direct): ", JSON.stringify(dAB));
    console.log("  diff B→C (CDP real):           ", JSON.stringify(dBC));
    console.log("ENGINE LOG FINAL:", engineTail(cdp, 12));
    console.log("DONE");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  if (CDP_REF) {
    const lines = CDP_REF.consoleLines.filter((l) => l.includes("cs16-engine"));
    console.error("--- últimos logs del motor ---");
    for (const l of lines.slice(-10)) console.error(" ", l);
  }
  process.exit(1);
});
