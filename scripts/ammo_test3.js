/**
 * E2E test: ¿compran munición las teclas , . y ; ? (CS 1.6 web port)
 *
 * Contexto: fix en engine.ts — binds clásicos que faltaban:
 *   ,  → buyammo1 (munición primaria)
 *   .  → buyammo2 (munición secundaria/pistola)
 *   ;  → buyammo1 (teclado ES: Shift+coma produce ";"; bind con forma
 *        entrecomillada porque ";" sin comillas es separador de comandos
 *        en la consola del motor)
 *
 * Protocolo (buytime amplio + dinero alto vía rcon):
 *   1. boot → join (5/5/1)
 *   2. rcon: mp_startmoney 16000, sv_cheats 1, sv_restart 1
 *   3. give weapon_ak47 (client console, requiere sv_cheats)
 *   4. disparar 8 balas → captura (clip < 30)
 *   5. ","  → captura (money baja; reserve sigue 90 si está llena)
 *   6. R recarga → "," de nuevo → reserve sube hasta el máximo
 *   7. "."  → munición de pistola (reserve secundaria sube)
 *   8. ";"  → igual que "," (money baja otra vez)
 *   9. consultas `bind <tecla>` al motor (se capturan en consola)
 *
 * Fase 2: arma primaria real vía autobuy (cl_setautobuy m4a1 + autobuy),
 * luego disparar, recargar y pulsar , y ; — el delta de DINERO en el HUD
 * prueba cada compra (buyammo1 = $60 por clip de M4A1).
 *
 * Run: bun /home/z/my-project/scripts/ammo_test3.js
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9338;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-ammo3";
const SHOT = (n) => `/home/z/my-project/scripts/ammo3_${n}.png`;

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
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no encontré el target CDP");
}

async function trustedClick(cdp, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(80);
  }
}

async function pressKey(cdp, key, code, vk, text) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    code,
    key,
    text,
    unmodifiedText: text,
  });
  await sleep(80);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    code,
    key,
  });
  await sleep(80);
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
        onGame = await cdp.eval(`!!window.__cs16engine`, 12000);
      } catch {
        continue;
      }
    }
    if (!onGame) throw new Error("no llegó a la pantalla de juego");
    console.log("[5] game screen OK");

    const box = await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    await trustedClick(cdp, box.x, box.y);
    await sleep(800);
    console.log("[6] pointer locked:", await cdp.eval(`!!document.pointerLockElement`));

    console.log("[7] waiting for join...");
    let joined = false;
    for (let i = 0; i < 36 && !joined; i++) {
      await sleep(5000);
      joined = cdp.consoleLines.some((l) => l.includes("conexión establecida"));
    }
    const bindsLog = cdp.consoleLines.find((l) => l.includes("binds clásicos"));
    console.log("[8] binds log:", bindsLog ?? "(no visto)");
    console.log("[9] joined:", joined);

    for (const [k, code, vk, t] of [
      ["5", "Digit5", 53, "5"],
      ["5", "Digit5", 53, "5"],
      ["1", "Digit1", 49, "1"],
    ]) {
      await pressKey(cdp, k, code, vk, t);
      await sleep(4500);
    }

    console.log("[10] rcon: dinero alto + restart...");
    const rcon = Bun.spawnSync(
      ["python3", "/home/z/my-project/scripts/rcon.py",
       "mp_startmoney 16000", "sv_restart 1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log("[rcon]", rcon.stdout.toString().trim().slice(0, 200));
    await sleep(14000);

    console.log("[11] autobuy M4A1...");
    await cdp.eval(
      `window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString('cl_setautobuy "m4a1"')`,
    );
    await sleep(300);
    await cdp.eval(
      `window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString('autobuy')`,
    );
    await sleep(3000);
    await cdp.screenshot(SHOT("m4"));

    console.log("[12] disparando 8 balas (clip 30→22)...");
    for (let i = 0; i < 8; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1,
      });
      await sleep(130);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1,
      });
      await sleep(220);
    }
    await sleep(600);
    await cdp.screenshot(SHOT("fired"));

    console.log("[13] R recarga (reserve baja)...");
    await pressKey(cdp, "r", "KeyR", 82, "r");
    await sleep(2500);
    await cdp.screenshot(SHOT("reload"));

    console.log("[14] pulsando ; (buyammo1 → money −$60 si el bind funciona)...");
    await pressKey(cdp, ";", "Semicolon", 186, ";");
    await sleep(1200);
    await cdp.screenshot(SHOT("semicolon"));

    console.log("[17] consultas de bind al motor:");
    for (const q of ['bind ","', 'bind "."', 'bind ";"']) {
      await cdp.eval(
        `window.__cs16engine && __cs16engine.engine.Cmd_ExecuteString(${JSON.stringify(q)})`,
      );
      await sleep(400);
    }
    const tail = cdp.consoleLines.filter((l) => l.includes("cs16-engine"));
    for (const l of tail.slice(-10)) console.log("   ", l.slice(0, 140));

    // restaurar servidor
    Bun.spawnSync(
      ["python3", "/home/z/my-project/scripts/rcon.py",
       "sv_cheats 0", "mp_startmoney 800", "mp_buytime 9"],
      { stdout: "ignore", stderr: "ignore" },
    );
    console.log("DONE — revisar ammo_*.png");
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
    for (const l of lines.slice(-12)) console.error(" ", l);
  }
  process.exit(1);
});
