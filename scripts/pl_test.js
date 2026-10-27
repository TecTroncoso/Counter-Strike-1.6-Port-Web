/**
 * E2E pointer-lock test for the CS 1.6 web port.
 *
 * Boots the game through the gateway (:81), waits for the game screen,
 * clicks the canvas with a TRUSTED CDP input event and checks that
 * document.pointerLockElement is the canvas.
 *
 * Run: bun /home/z/my-project/scripts/pl_test.js
 */
const CHROME = "/home/z/.agent-browser/browsers/chrome-155.0.8059.39/chrome";
const PORT = 9333;
const TARGET = "http://localhost:81/";
const PROFILE = "/home/z/my-project/scripts/.cdp-profile";

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
      "--window-size=1280,800",
      `--user-data-dir=${PROFILE}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    const wsUrl = await waitTarget();
    console.log("[2] CDP target:", wsUrl);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    console.log("[3] navigating to", TARGET);
    await cdp.send("Page.navigate", { url: TARGET });
    await sleep(4000);

    // instrument pointer-lock events early
    await cdp.eval(`(() => {
      window.__pl = [];
      document.addEventListener('pointerlockchange', () =>
        window.__pl.push('change:' + (document.pointerLockElement ? document.pointerLockElement.tagName : 'null')));
      document.addEventListener('pointerlockerror', () => window.__pl.push('error'));
      return 'instrumented';
    })()`);

    // click "JUGAR AHORA" with a trusted event
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
      const dbg = await cdp.eval(`({
        ready: document.readyState,
        url: location.href,
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 30)),
        text: document.body ? document.body.innerText.slice(0, 200) : '(no body)',
      })`).catch((e) => String(e));
      console.log("DEBUG página:", JSON.stringify(dbg, null, 2));
      throw new Error("botón JUGAR no encontrado");
    }
    console.log("[4] clicking JUGAR at", btn);
    await trustedClick(cdp, btn.x, btn.y);

    // wait for the game screen: canvas visible AND the exclusive game-hint line
    console.log("[5] waiting for boot (canvas visible + hint de captura)...");
    let onGame = false;
    for (let i = 0; i < 40; i++) {
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
        console.log(`    poll ${i}: eval lento (${String(e).slice(0, 60)})`);
        continue;
      }
      if (onGame) break;
      if (i % 4 === 3) {
        const tail = cdp.consoleLines.filter((l) => l.includes("cs16-engine")).slice(-2);
        console.log(`    ...${(i + 1) * 5}s`, tail.join(" | "));
      }
    }
    if (!onGame) throw new Error("el juego no llegó a la pantalla de juego");

    const engineLogs = cdp.consoleLines.filter((l) => l.includes("cs16-engine"));
    console.log("[6] game screen OK. Engine logs:", engineLogs.slice(-3));

    const canvasBox = await cdp.eval(`(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    await cdp.send("Page.captureScreenshot", { format: "png" })
      .then((r) => Bun.write("/home/z/my-project/scripts/pl_game.png", Buffer.from(r.data, "base64")))
      .then(() => console.log("    screenshot scripts/pl_game.png"));

    console.log("[7] clicking canvas at", canvasBox);
    await sleep(600);
    await trustedClick(cdp, canvasBox.x, canvasBox.y);
    await sleep(1000);

    const locked = await cdp.eval(
      `(() => {
        const el = document.pointerLockElement;
        return { locked: !!el, tag: el ? el.tagName + '#' + el.id : null, events: window.__pl };
      })()`,
    );
    console.log("[8] RESULT:", JSON.stringify(locked));

    await cdp.send("Page.captureScreenshot", { format: "png" })
      .then((r) => Bun.write("/home/z/my-project/scripts/pl_locked.png", Buffer.from(r.data, "base64")))
      .then(() => console.log("[9] screenshot scripts/pl_locked.png"));

    console.log(locked.locked ? "✔ RATÓN CAPTURADO (pointer lock OK)" : "✘ pointer lock NO activado");
  } finally {
    proc.kill();
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
