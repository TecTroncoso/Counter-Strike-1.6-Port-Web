/**
 * E2E test: B -> menú de compra en el CS 1.6 web port.
 *
 * Boot por gateway :81 → pointer lock → join HLDS → equipo (5) → pulsar B
 * con evento de teclado confiable (CDP) → screenshots del menú de compra.
 *
 * Run: bun /home/z/my-project/scripts/buy_test.js
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9334;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile-buy";

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
    try {
      const r = await this.send("Page.captureScreenshot", { format: "png" }, 12000);
      await Bun.write(path, Buffer.from(r.data, "base64"));
      return true;
    } catch (e) {
      console.log("    screenshot falló:", String(e).slice(0, 50));
      return false;
    }
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

let CDP_REF = null;

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
    if (!btn) {
      await cdp.screenshot("/home/z/my-project/scripts/buy_fail.png");
      const dbg = await cdp.eval(`({
        ready: document.readyState,
        url: location.href,
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 30)),
        err: document.body ? document.body.innerText.slice(0, 300) : '(no body)',
      })`).catch((e) => String(e));
      console.log("DEBUG página:", JSON.stringify(dbg, null, 2));
      throw new Error("botón JUGAR no encontrado");
    }
    console.log("[3] clicking JUGAR", btn);
    await trustedClick(cdp, btn.x, btn.y);

    console.log("[4] waiting for game screen (canvas visible)...");
    let onGame = false;
    for (let i = 0; i < 45; i++) {
      await sleep(5000);
      try {
        onGame = await cdp.eval(
          `(() => {
            const c = document.getElementById('canvas');
            return !!window.__cs16engine;
          })()`,
          12000,
        );
      } catch (e) {
        if (i % 6 === 5) console.log(`    poll ${i}: eval lento`);
        continue;
      }
      if (onGame) break;
    }
    if (!onGame) throw new Error("no llegó a la pantalla de juego");
    console.log("[5] game screen OK");

    const box = await (async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const b = await cdp.eval(`(() => {
            const c = document.getElementById('canvas');
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          if (b) return b;
        } catch {}
        await sleep(3000);
      }
      return { x: 512, y: 320 }; // fallback viewport 1024x640
    })();
    await trustedClick(cdp, box.x, box.y);
    await sleep(800);
    const lockState = await cdp.eval(`!!document.pointerLockElement`).catch(() => "?");
    console.log("[6] pointer locked:", lockState);

    console.log("[7] waiting for join (conexión establecida)...");
    let joined = false;
    for (let i = 0; i < 36 && !joined; i++) {
      await sleep(5000);
      joined = cdp.consoleLines.some((l) => l.includes("conexión establecida"));
      if (i % 4 === 3) {
        const tail = cdp.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-2);
        console.log(`    ...${(i + 1) * 5}s`, tail.join(" | "));
      }
    }
    const bindsLog = cdp.consoleLines.find((l) => l.includes("binds clásicos"));
    console.log("[8] binds log:", bindsLog ?? "(no visto)");
    console.log("[9] joined:", joined);

    // elegir equipo: el menú puede tardar en aparecer; 5 = auto-select,
    // 5 de nuevo = auto en menú de apariencia, 1 = primer modelo
    for (const [k, code, vk, t, wait] of [
      ["5", "Digit5", 53, "5", 4000],
      ["5", "Digit5", 53, "5", 4000],
      ["1", "Digit1", 49, "1", 7000],
    ]) {
      await pressKey(cdp, k, code, vk, t);
      await sleep(wait);
    }

    // dar buytime amplio y reiniciar la ronda para spawnear en zona de compra
    const rcon = Bun.spawnSync(
      ["python3", "/home/z/my-project/scripts/rcon.py", "mp_buytime 15", "sv_restart 1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log("[rcon]", rcon.stdout.toString().trim().slice(0, 250) || rcon.stderr.toString().slice(0, 150));
    await sleep(13000);

    // pulsar B e intentar ver el menú de compra (varios intentos por si
    // estamos muertos/espectando o fuera de buytime)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await pressKey(cdp, "b", "KeyB", 66, "b");
      await sleep(1500);
      await cdp.screenshot(`/home/z/my-project/scripts/buy_${attempt}.png`);
      console.log(`[10] attempt ${attempt}: screenshot buy_${attempt}.png`);
      const tail = cdp.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-2);
      console.log("     engine:", tail.join(" | "));
      await sleep(12000);
    }

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
    for (const l of lines.slice(-12)) console.error(" ", l);
  }
  process.exit(1);
});
