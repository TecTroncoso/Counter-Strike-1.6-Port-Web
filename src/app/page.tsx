"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bootGame, friendlyBootError, type EngineHandle } from "@/lib/cs16/engine";
import { bridgeHttpUrl } from "@/lib/cs16/bridge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Screen = "menu" | "loading" | "game";

interface ServerStatus {
  hlds: boolean;
  clients: number;
  uptimeSec: number;
  map: string;
  bots: number;
  maxPlayers: number;
}

const CONTROLS: { keys: string; action: string }[] = [
  { keys: "W A S D", action: "Moverse" },
  { keys: "Ratón", action: "Apuntar (clic para capturar)" },
  { keys: "Clic izq.", action: "Disparar" },
  { keys: "R", action: "Recargar" },
  { keys: "B", action: "Menú de compra" },
  { keys: "E", action: "Usar / plantar / defusar" },
  { keys: "1 / 2 / 3", action: "Primaria / pistola / cuchillo" },
  { keys: "Ctrl / Shift", action: "Agacharse / caminar" },
  { keys: "Space", action: "Saltar" },
  { keys: "Tab", action: "Marcador" },
  { keys: "º / `", action: "Consola del motor" },
  { keys: "Esc", action: "Menú del juego (libera el ratón)" },
];

export default function Cs16Page() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [nickname, setNickname] = useState("Player");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [bootLogs, setBootLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [lockBlocked, setLockBlocked] = useState(false);
  const [showLockHint, setShowLockHint] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const bootingRef = useRef(false);
  const clickRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickRetriesRef = useRef(0);
  const lastClickRef = useRef(0);
  // Virtual cursor for the mouse-look rewriter (see below).
  const mouseFixRef = useRef({ accX: 0, accY: 0, init: false });

  // Restore persisted settings AFTER hydration (no SSR mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("cs16.settings");
      if (raw) {
        const s = JSON.parse(raw) as Partial<{ nickname: string }>;
        if (s.nickname) setNickname(s.nickname);
      }
    } catch {}
    setSettingsLoaded(true);
  }, []);

  // Persist settings on change.
  useEffect(() => {
    if (!settingsLoaded) return;
    try {
      localStorage.setItem("cs16.settings", JSON.stringify({ nickname }));
    } catch {}
  }, [settingsLoaded, nickname]);

  const pushLog = useCallback((line: string) => {
    console.log("[cs16-engine]", line);
    setBootLogs((prev) => [...prev.slice(-40), line]);
  }, []);

  // Poll bridge health while in the menu
  useEffect(() => {
    if (screen !== "menu") return;
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(bridgeHttpUrl("/health"), { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ServerStatus;
        if (alive) setServerStatus(data);
      } catch {
        if (alive) setServerStatus(null);
      }
    };
    void check();
    const t = setInterval(check, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [screen]);

  const quitGame = useCallback(() => {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {}
    engineRef.current?.dispose();
    engineRef.current = null;
    bootingRef.current = false;
    setScreen("menu");
    setProgress(0);
    setProgressLabel("");
    setBootLogs([]);
    setError(null);
    // Reload to fully tear down the WASM engine (can't be re-inited in place)
    window.location.reload();
  }, []);

  // Retry = reload the page with an autostart flag (a partially-booted WASM
  // engine can't be re-inited in place; a fresh page is the reliable path).
  // Assets already downloaded stay in the browser HTTP cache, so the retry
  // skips the ~220 MB download.
  const retryBoot = useCallback(() => {
    try {
      localStorage.setItem("cs16.autostart", "1");
    } catch {}
    window.location.reload();
  }, []);

  const goFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void canvasRef.current?.parentElement?.requestFullscreen?.();
    }
  }, []);

  // ---- Mouse capture (Pointer Lock) ----------------------------------------
  // Browsers only grant pointer lock inside a real user gesture, so the engine
  // can't grab the mouse on its own. Every click on the canvas requests the
  // lock (raw/unadjusted movement when available = m_rawinput 1). Esc releases
  // it; Chrome enforces a ~1.25 s cooldown before re-locking, so a click that
  // lands inside that window is silently retried once the cooldown expires.
  const requestLock = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || document.pointerLockElement === canvas) return;
    type LockOpts = { unadjustedMovement?: boolean };
    const req = canvas.requestPointerLock as
      | ((o?: LockOpts) => Promise<void> | undefined)
      | undefined;
    try {
      const p = req?.call(canvas, { unadjustedMovement: true });
      if (p && typeof p.then === "function") {
        p.catch(() => {
          try {
            canvas.requestPointerLock();
          } catch {
            /* pointerlockerror will fire */
          }
        });
      }
    } catch {
      try {
        canvas.requestPointerLock();
      } catch {
        /* pointerlockerror will fire */
      }
    }
  }, []);

  const onCanvasClick = useCallback(() => {
    if (screen !== "game") return;
    lastClickRef.current = Date.now();
    clickRetriesRef.current = 0;
    setLockBlocked(false);
    requestLock();
  }, [screen, requestLock]);

  useEffect(() => {
    if (screen !== "game") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onChange = () => {
      const locked = document.pointerLockElement === canvas;
      setPointerLocked(locked);
      if (locked) {
        setLockBlocked(false);
        clickRetriesRef.current = 0;
      }
      // Bridge the browser pointer-lock state into the engine's SDL backend:
      // 1) SDL relative mouse mode — without it the emscripten backend feeds
      //    the engine a FROZEN absolute cursor position (clientX stops
      //    updating while locked) and the view never turns.
      // 2) Re-emit 'pointerlockchange' on the canvas: SDL registers its own
      //    listener on the canvas element, but the browser fires the event on
      //    document, so SDL never learns about the real lock state.
      // The synthetic event doesn't bubble, so only SDL's canvas listener
      // (and nobody else) receives it; it reads the REAL pointerLockElement.
      engineRef.current?.setRelativeMouse(locked);
      canvas.dispatchEvent(new Event("pointerlockchange"));
    };
    const onError = () => {
      setPointerLocked(false);
      // Auto-retry a couple of times (covers Chrome's post-Esc cooldown of
      // ~1.25 s). If it still fails, likely a blocked cross-origin iframe:
      // offer opening the game in its own tab.
      if (clickRetriesRef.current >= 2) {
        if (Date.now() - lastClickRef.current < 6000) setLockBlocked(true);
        return;
      }
      clickRetriesRef.current += 1;
      if (clickRetryTimerRef.current) clearTimeout(clickRetryTimerRef.current);
      clickRetryTimerRef.current = setTimeout(() => {
        clickRetryTimerRef.current = null;
        if (document.pointerLockElement !== canvasRef.current) requestLock();
      }, 1400);
    };
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    return () => {
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
      if (clickRetryTimerRef.current) {
        clearTimeout(clickRetryTimerRef.current);
        clickRetryTimerRef.current = null;
      }
    };
  }, [screen, requestLock]);

  // ---- Mouse look rewriter --------------------------------------------------
  // The emscripten SDL2 backend computes look deltas from the cursor's
  // ABSOLUTE position (clientX/Y) unless SDL "relative mode" is on — and
  // that mode can't be enabled here: the engine never calls it and the SDL
  // exports aren't reachable from JS (only a whitelist is bound on Module).
  // While the pointer is locked the browser freezes clientX/Y, so SDL keeps
  // computing ZERO deltas and the view never turns.
  //
  // Fix: while locked, swallow every real mousemove at the capture phase and
  // re-dispatch a synthetic one whose position DOES move — a virtual cursor
  // anchored at the canvas center, offset by the accumulated movementX/Y.
  // SDL's absolute path then yields exactly the real mouse deltas. This is
  // independent of the SDL version compiled into the engine.
  useEffect(() => {
    if (screen !== "game") return;
    if (window.location.search.includes("nolookfix")) return; // debug bisect
    const rewrite = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if ((e as MouseEvent & { __cs16Fix?: boolean }).__cs16Fix) return;
      if (document.pointerLockElement !== canvas) {
        mouseFixRef.current.init = false;
        return; // unlocked: real coordinates are fine, pass through
      }
      const s = mouseFixRef.current;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (!s.init) {
        // First event after capture: anchor the virtual cursor exactly on
        // the frozen real position so the first delta is not a jump.
        s.accX = e.clientX - cx;
        s.accY = e.clientY - cy;
        s.init = true;
      }
      e.stopImmediatePropagation();
      s.accX += e.movementX || 0;
      s.accY += e.movementY || 0;
      if (Math.abs(s.accX) > 1e9 || Math.abs(s.accY) > 1e9) {
        s.accX = 0;
        s.accY = 0;
      }
      const fix = new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      const f = fix as MouseEvent & { __cs16Fix?: boolean };
      f.__cs16Fix = true;
      Object.defineProperty(fix, "clientX", { value: cx + s.accX });
      Object.defineProperty(fix, "clientY", { value: cy + s.accY });
      Object.defineProperty(fix, "movementX", { value: e.movementX || 0 });
      Object.defineProperty(fix, "movementY", { value: e.movementY || 0 });
      canvas.dispatchEvent(fix);
    };
    window.addEventListener("mousemove", rewrite, true);
    return () => window.removeEventListener("mousemove", rewrite, true);
  }, [screen]);

  const openInNewTab = useCallback(() => {
    window.open(window.location.href, "_blank", "noopener");
  }, []);

  const start = useCallback(
    async () => {
      if (bootingRef.current || engineRef.current) return;
      bootingRef.current = true;
      setError(null);
      setBootLogs([]);
      setProgress(0);
      setProgressLabel("Preparando...");
      setScreen("loading");

      // Give React a tick to mount the canvas-sized loading UI
      await new Promise((r) => setTimeout(r, 50));
      const canvas = canvasRef.current;
      if (!canvas) {
        setError("No se encontró el canvas del juego");
        bootingRef.current = false;
        setScreen("menu");
        return;
      }

      try {
        const maxW = Math.min(window.innerWidth, 1920);
        canvas.width = maxW;
        canvas.height = Math.min(window.innerHeight, 1080);
        const handle = await bootGame({
          canvas,
          mode: "multiplayer",
          nickname,
          onProgress: (pct, label) => {
            setProgress(pct);
            setProgressLabel(label);
          },
          onLog: pushLog,
        });
        engineRef.current = handle;
        // Debug/testing hook: lets the E2E harness probe engine + SDL state
        // (see scripts/look_test.js). Harmless in production.
        (window as unknown as { __cs16engine?: unknown }).__cs16engine = handle;
        setScreen("game");
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e, Object.getOwnPropertyNames(e as object));
        setError(friendlyBootError(msg));
        console.error("[cs16] boot error:", e);
        console.error("[cs16] boot stack:", (e as Error)?.stack ?? "(sin stack)");
        bootingRef.current = false;
        setScreen("menu");
      }
    },
    [nickname, pushLog],
  );

  // Auto-restart once after a "Reintentar" reload (flag is consumed here).
  useEffect(() => {
    if (!settingsLoaded) return;
    let autostart = false;
    try {
      autostart = localStorage.getItem("cs16.autostart") === "1";
      localStorage.removeItem("cs16.autostart");
    } catch {
      return;
    }
    if (!autostart) return;
    const t = setTimeout(() => void start(), 400);
    return () => clearTimeout(t);
  }, [settingsLoaded, start]);

  useEffect(() => {
    // The big center hint only matters right after entering the game (and it
    // would cover the pause menu later on) — auto-fade after a few seconds.
    if (screen !== "game") {
      setShowLockHint(false);
      return;
    }
    setShowLockHint(true);
    const t = setTimeout(() => setShowLockHint(false), 6000);
    return () => clearTimeout(t);
  }, [screen]);

  // Detect renderer death (WebGL context loss — usually memory pressure)
  // so the user gets a recovery action instead of a frozen black canvas.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onLost = (e: Event) => {
      e.preventDefault();
      setError("El renderizador WebGL se detuvo (normalmente por memoria). Reinicia el juego para volver a entrar.");
    };
    c.addEventListener("webglcontextlost", onLost);
    return () => c.removeEventListener("webglcontextlost", onLost);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const serverBadge = serverStatus?.hlds ? (
    <span className="inline-flex items-center gap-2 text-[#8fd18f]">
      <span className="h-2 w-2 rounded-full bg-[#8fd18f] shadow-[0_0_8px_#8fd18f]" />
      Servidor HLDS online {serverStatus.clients > 0 ? `· ${serverStatus.clients} jugador(es)` : `· ${serverStatus.bots} bots jugando`}
    </span>
  ) : (
    <span className="inline-flex items-center gap-2 text-[#d18f8f]">
      <span className="h-2 w-2 rounded-full bg-[#d18f8f]" />
      Servidor no disponible (reintentando...)
    </span>
  );

  return (
    <main className="min-h-screen bg-[#0b0d0c] text-[#d8d3c8] overflow-hidden">
      {/* In-game canvas. NEVER display:none — the engine reads the canvas's
          CSS size at SDL video init; a hidden element reports 0×0 and the
          drawing buffer gets zeroed (void world). While in the menu/loading
          screens it stays laid out but invisible and click-through. */}
      <div
        className={
          screen === "game"
            ? "fixed inset-0 z-40 bg-black"
            : "fixed inset-0 z-0 bg-black opacity-0 pointer-events-none"
        }
      >
        {/*
          id="canvas": the emscripten glue in xash3d-fwgs resolves SDL's
          event target with document.querySelector("#canvas") (its
          specialHTMLTargets array lacks the '#canvas' entry), so the game
          canvas MUST have this exact id or the engine receives NO mouse
          events (no look, no click-to-shoot).
        */}
        <canvas
          id="canvas"
          ref={canvasRef}
          onClick={onCanvasClick}
          className="h-full w-full block"
        />
        {/* Game overlay controls */}
        <div className="fixed right-3 top-3 z-50 flex gap-2 opacity-40 transition-opacity hover:opacity-100">
          <button
            onClick={goFullscreen}
            className="rounded bg-black/70 px-3 py-1.5 font-mono text-xs text-[#e8c07a] ring-1 ring-[#e8c07a]/40 hover:bg-black/90"
          >
            ⛶ Pantalla completa
          </button>
          <button
            onClick={quitGame}
            className="rounded bg-black/70 px-3 py-1.5 font-mono text-xs text-[#e07a7a] ring-1 ring-[#e07a7a]/40 hover:bg-black/90"
          >
            ✕ Salir
          </button>
        </div>
        {/* Mouse-capture hint (click never reaches the canvas through this) */}
        {!pointerLocked && !error && showLockHint && (
          <div className="pointer-events-none fixed inset-0 z-[45] flex items-center justify-center">
            <div className="rounded-lg border border-[#e8c07a]/40 bg-black/70 px-6 py-4 text-center shadow-lg">
              <p className="font-mono text-sm font-bold uppercase tracking-widest text-[#e8c07a]">
                🖱 Haz clic para capturar el ratón
              </p>
              <p className="mt-1 font-mono text-[11px] text-[#b5b0a4]">
                Esc lo libera · los menús del juego se usan con el ratón capturado
              </p>
            </div>
          </div>
        )}
        {lockBlocked && !pointerLocked && (
          <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/80 px-6">
            <div className="max-w-md rounded border border-[#e8c07a]/40 bg-[#161410] p-6 text-center">
              <p className="font-mono text-sm leading-relaxed text-[#e8c07a]">
                El navegador bloqueó la captura del ratón (suele pasar dentro de un marco/iframe).
              </p>
              <p className="mt-2 font-mono text-xs leading-relaxed text-[#b5b0a4]">
                Abre el juego en su propia pestaña y haz clic sobre la pantalla.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  onClick={openInNewTab}
                  className="h-9 bg-[#e8c07a] px-4 font-mono text-xs font-bold uppercase tracking-wider text-[#1a140a] hover:bg-[#f0cf92]"
                >
                  ↗ Abrir en pestaña nueva
                </Button>
                <Button
                  onClick={() => setLockBlocked(false)}
                  className="h-9 border border-[#5a4030] bg-transparent px-4 font-mono text-xs text-[#d8d3c8] hover:bg-[#2a1c14]"
                >
                  Cerrar
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded bg-black/60 px-4 py-1.5 font-mono text-[11px] text-[#e8c07a]/90">
          {pointerLocked
            ? "Ratón capturado · B compra · , . munición · Esc libera el ratón · ` consola"
            : "Menú de equipo: pulsa 5 (auto) · Haz clic para capturar el ratón · B compra · , . munición · ` consola"}
        </div>
        {/* Renderer-death recovery overlay */}
        {error && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 px-6">
            <div className="max-w-md rounded border border-[#e07a7a]/40 bg-[#1a1010] p-6 text-center">
              <p className="font-mono text-sm leading-relaxed text-[#e0a0a0]">⚠ {error}</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  onClick={retryBoot}
                  className="h-9 bg-[#e8c07a] px-4 font-mono text-xs font-bold uppercase tracking-wider text-[#1a140a] hover:bg-[#f0cf92]"
                >
                  ↻ Reiniciar juego
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Loading screen */}
      {screen === "loading" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0b0d0c] px-6">
          <div className="w-full max-w-xl">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-mono text-sm uppercase tracking-widest text-[#e8c07a]">
                {"Conectando al servidor..."}
              </span>
              <span className="font-mono text-sm text-[#8a877f]">{Math.round(progress)}%</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-sm border border-[#3a3d38] bg-[#151714]">
              <div
                className="h-full bg-gradient-to-r from-[#8a5a1e] to-[#e8c07a] transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-3 font-mono text-xs text-[#b5b0a4]">{progressLabel}</p>
            <div className="mt-6 max-h-56 overflow-y-auto rounded border border-[#2a2d28] bg-[#101210] p-3 font-mono text-[11px] leading-relaxed text-[#7f8a7f]">
              {bootLogs.length === 0 && <p className="text-[#5a5f58]">Esperando eventos del motor...</p>}
              {bootLogs.map((l, i) => (
                <p key={i}>▸ {l}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main menu */}
      {screen === "menu" && (
        <div className="relative min-h-screen">
          {/* background flavor */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, transparent, transparent 3px, #e8c07a 3px, #e8c07a 4px)",
            }}
          />
          <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-8 sm:px-8">
            <header className="mb-8">
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-[#8a877f]">Web port · motor Xash3D (WASM)</p>
              <h1 className="mt-2 text-4xl font-black uppercase leading-none tracking-tight text-[#e8c07a] sm:text-6xl">
                Counter-Strike <span className="text-[#d8d3c8]">1.6</span>
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#b5b0a4]">
                El CS 1.6 real corriendo en el navegador: motor compatible con GoldSrc compilado a WebAssembly,
                lógica de juego open-source (cs16-client + ReGameDLL), bots YaPB y servidor dedicado HLDS para
                multijugador. Las primeras <b>descargas cachean ~220 MB de assets</b> del juego.
              </p>
              <div className="mt-3">{serverBadge}</div>
            </header>

            {error && (
              <div className="mb-6 rounded border border-[#e07a7a]/40 bg-[#2a1414] p-4">
                <p className="font-mono text-sm text-[#e0a0a0]">⚠ {error}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    onClick={retryBoot}
                    className="h-9 bg-[#e8c07a] px-4 font-mono text-xs font-bold uppercase tracking-wider text-[#1a140a] hover:bg-[#f0cf92]"
                  >
                    ↻ Reintentar
                  </Button>
                  <Button
                    onClick={() => setError(null)}
                    className="h-9 border border-[#5a4030] bg-transparent px-4 font-mono text-xs text-[#d8d3c8] hover:bg-[#2a1c14]"
                  >
                    Cerrar
                  </Button>
                </div>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-[#a08080]">
                  Los archivos ya descargados (~220 MB) siguen en la caché del navegador: el reintento es rápido.
                </p>
              </div>
            )}

            <div className="grid flex-1 items-start gap-6 lg:grid-cols-2">
              {/* Config panel */}
              <section className="rounded border border-[#2e312c] bg-[#121412] p-5">
                <h2 className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-[#e8c07a]">Configuración</h2>
                <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-[#8a877f]">Tu nombre</label>
                <Input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value.slice(0, 24))}
                  maxLength={24}
                  placeholder="Player"
                  className="mb-4 border-[#3a3d38] bg-[#191b18] font-mono text-sm"
                />

                <div className="mb-2 grid grid-cols-1 gap-2">
                  <div className="rounded border border-[#e8c07a]/30 bg-[#e8c07a]/5 px-3 py-2 font-mono text-xs text-[#e8c07a]">
                    🤖 Bots YaPB jugando en el servidor + 🌐 multijugador por túnel WebSocket→UDP
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded border border-[#2e312c] bg-[#191b18] p-3 font-mono text-xs leading-relaxed text-[#b5b0a4]">
                    <p className="text-[#e8c07a]">
                      ▸ {serverStatus?.hlds
                        ? `hlserver:27015 — ${serverStatus.map} en curso`
                        : "esperando servidor..."}
                    </p>
                    {serverStatus && (
                      <p className="mt-1 text-[#7f7a70]">
                        uptime: {Math.floor(serverStatus.uptimeSec / 60)} min · clientes: {serverStatus.clients} · bots: {serverStatus.bots} · máximo: {serverStatus.maxPlayers}
                      </p>
                    )}
                  </div>
                  <p className="font-mono text-[11px] leading-relaxed text-[#7f7a70]">
                    Te unes a un servidor dedicado HLDS real de 32 bits con rondas clásicas de
                    bomba/rehén. Abre esta página en otra pestaña o dispositivo para jugar juntos.
                  </p>
                </div>

                <Button
                  onClick={() => void start()}
                  className="mt-5 w-full bg-[#e8c07a] py-6 font-mono text-base font-bold uppercase tracking-[0.2em] text-[#1a140a] hover:bg-[#f0cf92]"
                >
                  ▶ Jugar ahora
                </Button>
                <p className="mt-2 text-center font-mono text-[10px] text-[#5a5f58]">
                  Primera carga: ~220 MB (cacheado). Al entrar pulsa 5 para elegir equipo. Haz clic para capturar el ratón.
                </p>
              </section>

              {/* Info panel */}
              <section className="space-y-6">
                <div className="rounded border border-[#2e312c] bg-[#121412] p-5">
                  <h2 className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-[#e8c07a]">Controles</h2>
                  <div className="grid gap-x-6 gap-y-1.5 font-mono text-xs sm:grid-cols-2">
                    {CONTROLS.map((c) => (
                      <div key={c.keys} className="flex items-baseline justify-between gap-2 border-b border-[#1f221e] pb-1.5">
                        <span className="text-[#e8c07a]">{c.keys}</span>
                        <span className="text-right text-[#8a877f]">{c.action}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded border border-[#2e312c] bg-[#121412] p-5">
                  <h2 className="mb-3 font-mono text-xs uppercase tracking-[0.25em] text-[#e8c07a]">Cómo funciona</h2>
                  <ul className="space-y-2 font-mono text-[11px] leading-relaxed text-[#8a877f]">
                    <li>
                      <b className="text-[#b5b0a4]">Motor:</b> Xash3D FWGS (reimplementación open-source de GoldSrc)
                      compilado a WebAssembly con renderizador WebGL2.
                    </li>
                    <li>
                      <b className="text-[#b5b0a4]">Juego:</b> cs16-client (cliente CS 1.6 open-source) + ReGameDLL
                      (lógica de servidor) compilados a WASM — corren dentro de tu navegador.
                    </li>
                    <li>
                      <b className="text-[#b5b0a4]">Bots:</b> YaPB (Yet Another PodBot) en WASM para partidas locales,
                      y en el servidor dedicado vía metamod.
                    </li>
                    <li>
                      <b className="text-[#b5b0a4]">Multijugador:</b> túnel WebSocket→UDP contra HLDS real
                      (protocolo 48). Compatible también con clientes nativos de CS 1.6.
                    </li>
                    <li>
                      <b className="text-[#b5b0a4]">Assets:</b> mapas/modelos/sonidos servidos como un sv_downloadurl
                      clásico de servidor; Counter-Strike es marca de Valve.
                    </li>
                  </ul>
                </div>
              </section>
            </div>

            <footer className="mt-10 border-t border-[#1f221e] pt-4 font-mono text-[10px] leading-relaxed text-[#5a5f58]">
              Proyecto técnico basado en Xash3D-FWGS (GPL), cs16-client, ReGameDLL-CS y YaPB (todos open-source).
              Counter-Strike y Half-Life son marcas de Valve Corporation. Proyecto independiente sin afiliación.
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
