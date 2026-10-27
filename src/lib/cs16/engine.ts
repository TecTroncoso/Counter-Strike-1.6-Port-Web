/**
 * CS 1.6 Web Port — engine bootstrap.
 *
 * Boots the real GoldSrc-engine-compatible Xash3D FWGS (WebAssembly) with the
 * open-source CS 1.6 client/server libraries (cs16-client + ReGameDLL + YaPB
 * bots), mounting the user-served game assets into the engine filesystem.
 */
import { Xash3D, Net } from "xash3d-fwgs";
import { WsUdpSender } from "./net";
import { bridgeWsUrl, bridgeHttpUrl, assetUrl } from "./bridge";
import { downloadAuxAssets, downloadGameZip, mountGameFiles, type AuxAssets } from "./loader";

export type GameMode = "local" | "multiplayer";

/** Maps raw boot errors to a human-friendly message (network drops, etc). */
export function friendlyBootError(msg: string): string {
  if (/failed to fetch|networkerror|load failed|network/i.test(msg)) {
    return (
      msg +
      " — se perdió la conexión durante la descarga. Lo ya descargado sigue en la caché del navegador: pulsa «Reintentar»."
    );
  }
  return msg;
}

export interface BootOptions {
  canvas: HTMLCanvasElement;
  mode: GameMode;
  nickname: string;
  map: string;
  bots: number;
  onProgress: (pct: number, label: string) => void;
  onLog: (line: string) => void;
}

export interface EngineHandle {
  engine: Xash3D;
  tunnel: WsUdpSender | null;
  /**
   * Toggle SDL2 relative mouse mode (mirrors the pointer lock state).
   * Without it the emscripten SDL backend feeds the engine the cursor's
   * ABSOLUTE position, which freezes while the pointer is locked, so the
   * view never turns. See look_test.js for the E2E evidence.
   */
  setRelativeMouse: (on: boolean) => void;
  dispose: () => void;
}

// bridgeWsUrl() (imported from ./bridge) honours NEXT_PUBLIC_CS16_BRIDGE_URL
// for split deployments (Cloudflare frontend + Render bridge); in same-origin
// deployments it resolves through the gateway (?XTransformPort=3010).

export async function bootGame(opts: BootOptions): Promise<EngineHandle> {
  const { canvas, onProgress, onLog } = opts;

  // Engine console capture. Fed from BOTH the engine's stdout (print) and the
  // condebug file pump below — used to detect connection progress without
  // depending on filesystem writes that may fail in a read-only mount.
  let engineConsole = "";

  let zipBlob: Blob | null = null;
  let aux: AuxAssets | null = null;

  // 1. Download + verify game assets (cached by the browser after first run).
  //    ALL network I/O happens in these two steps, with retries — the mount
  //    phase below is 100 % offline so a dropped connection can't kill it.
  try {
    onProgress(2, "Descargando assets del juego...");
    zipBlob = await downloadGameZip((pct, label) => onProgress(pct, label), onLog);
  } catch (e) {
    throw new Error(`[descarga] ${String(e)}`);
  }
  try {
    aux = await downloadAuxAssets((pct, label) => onProgress(pct, label), onLog);
  } catch (e) {
    throw new Error(`[assets aux] ${String(e)}`);
  }

  // 2. Create engine + network backend
  onProgress(63, "Inicializando motor Xash3D (WebAssembly)...");
  const engine = new Xash3D({
    canvas,
    arguments: [
      "-windowed",
      "-game", "cstrike",
      "+_vgui_menus", "0",
      "-ref", "webgl2",
      "-width", String(canvas.width || 1280),
      "-height", String(canvas.height || 720),
      "+name", opts.nickname || "Player",
      "+fps_max", "144",
      "+condebug", "1",
      // Raw mouse input: some builds gate Platform_MouseMove on this cvar
      // (SDL_GetRelativeMouseState vs warp-to-center). With the browser
      // pointer lock, only the relative-state path can ever work.
      "+m_rawinput", "1",
    ],
    dynamicLibraries: [
      "filesystem_stdio.wasm",
      "libref_webgl2.wasm",
      "cl_dlls/menu_emscripten_wasm32.wasm",
      "dlls/cs_emscripten_wasm32.wasm",
      "cl_dlls/client_emscripten_wasm32.wasm",
      "dlls/yapb_emscripten_wasm32.wasm",
      "/rodir/filesystem_stdio.wasm",
    ],
    module: {
      // Emscripten built-in: clicking the canvas requests pointer lock (the
      // engine can't do it alone — browsers require a user gesture). We also
      // manage lock from the React side for UX hints and error recovery.
      elementPointerLock: true,
      print: (text: string) => {
        engineConsole += "\n" + text;
        onLog(text);
      },
      printErr: (text: string) => {
        engineConsole += "\n" + text;
        onLog(`! ${text}`);
      },
      // The engine resolves its game dir against the executable path root
      // ("/cstrike", "/valve"). Create symlinks so those resolve to the
      // real game files we mount under /rodir.
      preRun: [
        (mod: {
          FS: {
            mkdirTree: (p: string) => void;
            chdir: (p: string) => void;
            symlink: (target: string, path: string) => void;
          };
        }) => {
          const FS = mod.FS;
          FS.mkdirTree("/rodir");
          FS.chdir("/rodir");
          for (const dir of ["cstrike", "valve"]) {
            try {
              FS.mkdirTree(`/rodir/${dir}`);
            } catch {}
            try {
              FS.symlink(`/rodir/${dir}`, `/${dir}`);
            } catch {}
          }
        },
      ],
    } as never,
    filesMap: {
      "xash.wasm": assetUrl("/assets/engine/xash.wasm"),
      "filesystem_stdio.wasm": assetUrl("/assets/engine/filesystem_stdio.wasm"),
      "libref_webgl2.wasm": assetUrl("/assets/engine/libref_webgl2.wasm"),
      "/rodir/filesystem_stdio.wasm": assetUrl("/assets/engine/filesystem_stdio.wasm"),
      // The wrapper auto-preloads the default (HL) server library; serve the
      // Counter-Strike one under that name too so the fetch never 404s.
      "dlls/hl_emscripten_wasm32.wasm": assetUrl("/assets/engine/cs16/cs_emscripten_wasm32.wasm"),
      "cl_dlls/menu_emscripten_wasm32.wasm": assetUrl("/assets/engine/cs16/menu_emscripten_wasm32.wasm"),
      "dlls/cs_emscripten_wasm32.wasm": assetUrl("/assets/engine/cs16/cs_emscripten_wasm32.wasm"),
      "cl_dlls/client_emscripten_wasm32.wasm": assetUrl("/assets/engine/cs16/client_emscripten_wasm32.wasm"),
      "dlls/yapb_emscripten_wasm32.wasm": assetUrl("/assets/engine/cs16/yapb_emscripten_wasm32.wasm"),
    },
  });

  let tunnel: WsUdpSender | null = null;
  // The engine ALWAYS gets a virtual UDP backend: local loopback needs it and
  // multiplayer tunnels datagrams to the dedicated server over WebSocket.
  const virtualNet = new Net(
    { sendto: (packet) => senderRef.current?.sendto(packet) },
    { hostname: "webxash3d", hostID: 3000, maxPackets: 256 },
  );
  const senderRef: { current: WsUdpSender | null } = { current: null };
  const sender = new WsUdpSender(virtualNet, bridgeWsUrl(), onLog);
  senderRef.current = sender;
  (engine as unknown as { net: unknown }).net = virtualNet;
  tunnel = sender;

  // 3. Init WASM runtime
  onProgress(64, "Cargando WASM del motor...");
  try {
    await engine.init();
  } catch (e) {
    throw new Error(`[init wasm] ${String(e)}`);
  }

  // 4. Mount game files into the engine filesystem
  const fs = (engine.em as unknown as { FS: { mkdirTree: (p: string) => void; writeFile: (p: string, d: Uint8Array) => void; chdir: (p: string) => void; mkdir: (p: string) => void; readFile: (p: string, o?: { encoding?: string }) => Uint8Array | string } }).FS;
  try {
    await mountGameFiles(zipBlob, aux, fs, (pct, label) => onProgress(pct, label));
  } catch (e) {
    throw new Error(`[montaje] ${String(e)}`);
  }
  // Release the download buffers — the files now live in the engine FS.
  zipBlob = null;
  aux = null;

  // 5. Enter the game directory and start the engine main loop
  try {
    onProgress(97, "Arrancando Counter-Strike 1.6...");
    fs.chdir("/rodir");
  } catch (e) {
    throw new Error(`[chdir] ${String(e)}`);
  }
  try {
    engine.main();
  } catch (e) {
    const detail = e instanceof Error ? e.stack ?? e.message : JSON.stringify(e, Object.getOwnPropertyNames(e as object));
    throw new Error(`[main] ${detail}`);
  }

  // 6b. Pump the engine's own console (condebug) into our log overlay
  let lastLogLen = 0;
  const pumpConsole = () => {
    try {
      const data = fs.readFile("cstrike/console.log", { encoding: "utf8" }) as unknown as string;
      if (typeof data === "string" && data.length > lastLogLen) {
        const fresh = data.slice(lastLogLen).split("\n").filter(Boolean);
        lastLogLen = data.length;
        for (const line of fresh) onLog(line);
        engineConsole += "\n" + fresh.join("\n");
      }
    } catch {
      /* console.log not created yet */
    }
  };
  const pumpTimer = setInterval(pumpConsole, 800);

  // Retry wrapper for post-join commands (the first ccalls can throw while
  // the runtime settles, so retry briefly before giving up).
  const runCmd = async (cmd: string, retries = 5): Promise<boolean> => {
    for (let i = 0; i < retries; i++) {
      try {
        engine.Cmd_ExecuteString(cmd);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    onLog(`no se pudo ejecutar: ${cmd}`);
    return false;
  };

  // ---- Mouse look plumbing -------------------------------------------------
  // The emscripten SDL2 backend only delivers movementX/Y deltas while
  // mouse->relative_mode is on (pre-2.24 SDL keys the handler off this flag;
  // the engine never enables it by itself). SDL_SetRelativeMouseMode IS in
  // the wasm export table (dynamic-linking surface) but is NOT bound onto
  // Module, so plain ccall fails with "func is not a function" — resolve it
  // through the raw wasm exports instead. It fails (-1) while SDL has no
  // mouse-focus window yet — the page retries on every lock change.
  let sdlVersionLogged = false;
  const setRelativeMouse = (on: boolean) => {
    try {
      const em = engine.em as unknown as {
        Module?: Record<string, unknown> & {
          ccall?: (fn: string, ret: string, types: string[], args: unknown[]) => number;
        };
        wasmExports?: Record<string, ((...a: unknown[]) => number) | undefined>;
        asm?: Record<string, ((...a: unknown[]) => number) | undefined>;
      };
      const M = (em?.Module ?? em) as Record<string, unknown> | undefined;
      if (!M) return;
      if (!sdlVersionLogged) {
        sdlVersionLogged = true;
        const getVer =
          (M["_SDL_GetVersion"] as (() => number) | undefined) ??
          em?.wasmExports?.["SDL_GetVersion"] ??
          em?.asm?.["SDL_GetVersion"];
        if (typeof getVer === "function") {
          const ver = getVer();
          onLog(`SDL ${Math.floor(ver / 1000)}.${Math.floor((ver % 1000) / 100)}.${ver % 100} (backend emscripten)`);
        }
      }
      const setRel =
        (M["_SDL_SetRelativeMouseMode"] as ((v: number) => number) | undefined) ??
        em?.wasmExports?.["SDL_SetRelativeMouseMode"] ??
        em?.asm?.["SDL_SetRelativeMouseMode"];
      if (typeof setRel !== "function") {
        if (!sdlVersionLogged) {
          sdlVersionLogged = true;
          onLog("SDL_SetRelativeMouseMode no accesible desde JS — se usa el reescritor de ratón virtual");
        }
        return;
      }
      const ret = setRel(on ? 1 : 0);
      if (ret === 0) {
        onLog(on ? "modo ratón relativo activado (mirada por movementX)" : "modo ratón relativo desactivado");
      } else if (on) {
        onLog(`SDL_SetRelativeMouseMode(1) = ${ret} (el motor aún no tiene foco de ratón; se reintenta al capturar)`);
      }
    } catch {
      /* engine not ready or already torn down */
    }
  };

  // 6. Post-start: join the dedicated server (HLDS + YaPB bots).
  //
  // IMPORTANT: `connect` must NOT be re-sent while the handshake is running —
  // each re-send aborts the signon and restarts it from zero, so the client
  // would loop forever (repeating "Setting up renderer..."). We send it once
  // the engine runtime is ready, then only re-send if the server never
  // answers (checked via the bridge's UDP packet counters).
  setTimeout(() => {
    void (async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const healthUrl = bridgeHttpUrl("/health?XTransformPort=3010");
      let lastPacketsIn = -1;
      const readPacketsIn = async (): Promise<number> => {
        try {
          const res = await fetch(healthUrl, { cache: "no-store" });
          if (!res.ok) return lastPacketsIn < 0 ? 0 : lastPacketsIn;
          const d = (await res.json()) as { packetsIn?: number };
          return typeof d.packetsIn === "number" ? d.packetsIn : 0;
        } catch {
          return lastPacketsIn < 0 ? 0 : lastPacketsIn;
        }
      };

      try {
        onLog("conectando al servidor dedicado (HLDS + bots YaPB)...");

        // Classic CS 1.6 key binds. The engine only defaults movement keys
        // (WASD/space/mouse) and the shipped game files contain no config.cfg,
        // so mod commands like `buy` are never bound. Apply the standard
        // layout right after the engine console is usable. Key names are
        // case-insensitive in Xash3D (TAB/CTRL/SHIFT exist in its table).
        const CLASSIC_BINDS: Array<[string, string]> = [
          ["b", "buy"], // menú de compra
          ["o", "buyequip"], // menú de equipamiento
          ["r", "+reload"],
          ["e", "+use"],
          ["g", "drop"],
          ["m", "chooseteam"],
          ["n", "nightvision"],
          ["f", "impulse 100"], // linterna
          ["t", "impulse 201"], // spray
          ["TAB", "+showscores"], // marcador
          ["SHIFT", "+speed"], // caminar
          ["CTRL", "+duck"], // agacharse (el default del motor es +attack)
          [",", "buyammo1"], // munición primaria (tecla clásica de CS 1.6)
          [".", "buyammo2"], // munición secundaria (pistola)
          ["z", "radio1"], // menú de radio 1 (Cover me, ...)
          ["x", "radio2"], // menú de radio 2 (Go go go, ...)
          ["c", "radio3"], // menú de radio 3 (afirmativo, ...) — el default
          // del motor es +movedown, herencia de HL
          ["6", "slot6"], // slot6..slot10: navegación de menús clásicos
          ["7", "slot7"], // (6/7 = munición en el menú de compra, 0 = salir)
          ["8", "slot8"],
          ["9", "slot9"],
          ["0", "slot10"],
        ];
        let bindFails = 0;
        for (const [key, cmd] of CLASSIC_BINDS) {
          try {
            engine.Cmd_ExecuteString(`bind ${key} ${cmd}`);
          } catch {
            bindFails++;
          }
        }
        // ";" needs the quoted form: bare ";" would be parsed as a command
        // separator by the engine console (bind <no args> · buyammo1).
        // Covers ES keyboards where Shift+comma produces ";".
        try {
          engine.Cmd_ExecuteString(`bind ";" "buyammo1"`);
        } catch {
          bindFails++;
        }
        onLog(
          bindFails === 0
            ? "binds clásicos listos (B compra · , . munición · Z/X/C radio · R recarga · E usar · G soltar · CTRL agacharse · TAB marcador)"
            : `binds aplicados con ${bindFails} fallo(s)`,
        );

        // Probe relative mouse once at boot — if the user already pointer-
        // locked before this runs, no future lock change would arrive.
        setRelativeMouse(true);

        lastPacketsIn = await readPacketsIn();

        // 1) Send the first connect as soon as the engine accepts ccalls.
        let sent = false;
        for (let i = 0; i < 12 && !sent; i++) {
          try {
            engine.Cmd_ExecuteString("connect webxash3d.3000:27015");
            sent = true;
            onLog("connect enviado — negociando handshake con el servidor...");
          } catch {
            await sleep(1500);
          }
        }
        if (!sent) {
          onLog("el motor no aceptó el comando connect (¿falló el arranque?)");
          return;
        }

        // 2) Wait for the handshake. The engine echoes the target on stdout
        //    ("... server webxash3d.3000:27015") as soon as it starts the
        //    attempt; real progress shows up as growing UDP traffic on the
        //    bridge (userinfo, precache, then steady cmdrate).
        let acked = /server webxash3d|Connecting to|Netchan|Signon/i.test(engineConsole);
        let resendCount = 0;
        let joined = false;
        let lastTrafficAt = Date.now();
        let lastResendAt = Date.now();
        const deadline = Date.now() + 210000;
        while (Date.now() < deadline && !joined) {
          await sleep(3000);
          if (!acked && /server webxash3d|Connecting to|Netchan|Signon/i.test(engineConsole)) {
            acked = true;
            onLog("el motor inició el intento de conexión");
          }
          const now = await readPacketsIn();
          const delta = now - lastPacketsIn;
          lastPacketsIn = now;
          // A joined client streams ~8-30 cmd packets/s; a stuck handshake
          // sends almost nothing (a few retries per 20 s). Sustained traffic
          // beyond ~8/s means the client is fully in the game.
          if (delta > 25) {
            joined = true;
            break;
          }
          if (delta > 0) lastTrafficAt = Date.now();
          // Stuck at the challenge stage — typically the first connect landed
          // during a server changelevel and was silently dropped (challenge
          // replies still trickle in, so "traffic" alone can't be trusted).
          // Re-send while the engine shows NO signon activity yet; a joined
          // client always far exceeds 8 packets per 3 s window.
          if (!acked && delta < 8 && Date.now() - lastResendAt > 20000 && resendCount < 10) {
            try {
              engine.Cmd_ExecuteString("connect webxash3d.3000:27015");
              resendCount++;
              lastResendAt = Date.now();
              onLog(`sin progreso de handshake — reenviando connect (${resendCount}/10)...`);
            } catch {
              /* ignore */
            }
          }
        }

        if (joined) {
          onLog("conexión establecida — pulsa 5 para elegir equipo");
        } else if (acked) {
          onLog("handshake en curso sin confirmar (el juego sigue intentando)");
        } else {
          onLog("no se confirmó la conexión (¿está el servidor caído?)");
        }

        // 3) Server-side adjustments via rcon (map choice + bot quota).
        const waitJoined = async (ms: number) => {
          if (joined) await sleep(ms);
        };
        await waitJoined(8000);
        await runCmd("rcon_password csweb123");
        if (opts.map && opts.map !== "de_dust2") {
          await sleep(1500);
          await runCmd(`rcon changelevel ${opts.map}`);
          onLog(`cambiando mapa del servidor a ${opts.map}...`);
        }
        if (opts.bots > 0) {
          await sleep(1500);
          await runCmd(`rcon yb_quota ${opts.bots}`);
        }
      } catch (e) {
        onLog(`error enviando comandos: ${String(e)}`);
      }
    })();
  }, 2500);

  onProgress(100, "En el juego");

  return {
    engine,
    tunnel,
    setRelativeMouse,
    dispose: () => {
      try {
        clearInterval(pumpTimer);
        tunnel?.close();
        engine.quit();
      } catch {}
    },
  };
}
