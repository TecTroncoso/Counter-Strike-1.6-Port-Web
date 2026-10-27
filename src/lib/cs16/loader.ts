/**
 * CS 1.6 Web Port — asset loader.
 * Downloads valve.zip split parts (with SHA-256 integrity) and the auxiliary
 * engine assets, then streams the archive through fflate's incremental unzip,
 * writing each game file straight into the engine's Emscripten filesystem
 * (/rodir) without ever holding the whole archive in memory.
 *
 * RELIABILITY CONTRACT: every network access happens in the download phase
 * (downloadGameZip / downloadAuxAssets) with exponential-backoff retries.
 * mountGameFiles performs ZERO network requests — a flaky connection can
 * never kill the boot with "Failed to fetch" midway through mounting.
 */
import { Unzip, UnzipInflate } from "fflate";
import { assetUrl } from "./bridge";

export interface PartManifest {
  archiveSize: number;
  archiveSha256: string;
  partSize: number;
  partCount: number;
  parts: { file: string; size: number; sha256: string }[];
}

/** Auxiliary engine assets fetched during the download phase, before boot. */
export interface AuxAssets {
  /** extras.pk3 — CS client extra resources (required). */
  extras: Uint8Array;
  /** filesystem_stdio.wasm copy for the engine's read-only mount (optional). */
  fsLib: Uint8Array | null;
  /** Game-logic WASM libraries, keyed by their canonical /assets URL (optional). */
  libs: { url: string; bytes: Uint8Array }[];
}

const MAX_CONCURRENT = 4;
const RETRY_DELAYS = [1000, 2500, 5000, 10000]; // exponential-ish backoff (ms)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} en ${url}`);
  }
}

function shortUrl(url: string): string {
  return url.split("/").pop() ?? url;
}

/**
 * fetch() + read the whole body, with retries on network errors and 5xx/429.
 * The body is read INSIDE the retry window: broken mid-transfer responses
 * (the classic "TypeError: Failed to fetch") are retried transparently.
 * 404/403 fail fast — retrying a missing file is pointless.
 */
async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; onNote?: (msg: string) => void } = {},
): Promise<Blob> {
  const maxRetries = opts.retries ?? RETRY_DELAYS.length;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
      opts.onNote?.(
        `reintento ${attempt}/${maxRetries} de ${shortUrl(url)} en ${Math.round(delay / 1000)} s...`,
      );
      await sleep(delay);
    }
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) {
          lastError = new HttpError(res.status, url);
          continue; // transient server-side problem → retry
        }
        throw new HttpError(res.status, url); // 404/403 → no point retrying
      }
      return await res.blob();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = e; // network-level failure (TypeError: Failed to fetch…) → retry
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Descarga fallida: ${url}`);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Shared verified split-archive downloader (valve.zip, extras.pk3, ...).
 * Fetches {base}manifest.json, then every part in parallel (bounded), each
 * size+SHA-256 checked, and returns the reassembled disk-backed Blob.
 */
async function downloadSplitArchive(
  base: string,
  opts: {
    onProgress?: (frac: number, label: string) => void; // frac: 0..1 of this archive
    onNote?: (msg: string) => void;
  } = {},
): Promise<Blob> {
  const manifestBlob = await fetchRetry(`${base}manifest.json`, { cache: "no-cache" }, { onNote: opts.onNote });
  const manifest: PartManifest = JSON.parse(await manifestBlob.text()) as PartManifest;
  if (!manifest.parts?.length) throw new Error(`Manifest de assets inválido (${base})`);

  const partBlobs = new Array<Blob | null>(manifest.parts.length).fill(null);
  let next = 0;
  let downloaded = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= manifest.parts.length) return;
      const part = manifest.parts[idx];
      const url = `${base}${encodeURIComponent(part.file)}`;

      const grab = async (cacheMode: RequestCache) => {
        const blob = await fetchRetry(url, { cache: cacheMode }, { onNote: opts.onNote });
        if (blob.size !== part.size) throw new Error(`Tamaño inesperado en ${part.file}`);
        const hash = await sha256Hex(await blob.arrayBuffer());
        if (hash !== part.sha256) throw new Error(`Verificación SHA-256 falló en ${part.file}`);
        return blob;
      };

      // First try the browser HTTP cache, then once more bypassing it in case
      // a cached copy got corrupted; if both fail, surface the last error.
      let blob: Blob;
      try {
        blob = await grab("force-cache");
      } catch (e) {
        opts.onNote?.(`revalidando ${part.file} tras un fallo...`);
        blob = await grab("reload").catch(() => {
          throw e;
        });
      }

      partBlobs[idx] = blob;
      downloaded += blob.size;
      done++;
      opts.onProgress?.(
        Math.min(1, downloaded / manifest.archiveSize),
        `${done}/${manifest.parts.length} partes · ${Math.round((downloaded / 1e6) * 10) / 10} MB`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, manifest.parts.length) }, worker));

  // Disk-backed composite blob (Chromium spills large Blobs to disk, so this
  // does not duplicate the archive in RAM).
  return new Blob(partBlobs as Blob[], { type: "application/octet-stream" });
}

/** Downloads + verifies the split valve.zip archive (0→58 % of the boot bar). */
export async function downloadGameZip(
  onProgress: (pct: number, label: string) => void,
  onNote?: (msg: string) => void,
): Promise<Blob> {
  const blob = await downloadSplitArchive(assetUrl("/assets/valve-parts/"), {
    onNote,
    onProgress: (frac, label) => onProgress(Math.min(58, frac * 58), `Descargando assets (${label})`),
  });
  onProgress(58, "Assets verificados (SHA-256 por parte).");
  return blob;
}

/**
 * Downloads the auxiliary engine assets (extras.pk3 + WASM libraries) while
 * the page is still light on memory — done HERE so the mount phase never
 * touches the network (58→63 % of the boot bar).
 */
export async function downloadAuxAssets(
  onProgress: (pct: number, label: string) => void,
  onNote?: (msg: string) => void,
): Promise<AuxAssets> {
  onProgress(58, "Descargando extras del cliente CS (por partes)...");
  // extras.pk3 (25 MB) in gateway-safe 8 MB parts — single large responses get
  // cut mid-body by the preview proxy. Falls back to the single file if the
  // split manifest is not deployed.
  let extrasBlob: Blob;
  try {
    extrasBlob = await downloadSplitArchive(assetUrl("/assets/engine/cs16/extras-parts/"), {
      onNote,
      onProgress: (frac, label) => onProgress(58 + frac * 3, `Extras (${label})`),
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      onNote?.("manifest de extras no disponible — probando descarga directa...");
      extrasBlob = await fetchRetry(assetUrl("/assets/engine/cs16/extras.pk3"), { cache: "force-cache" }, { onNote });
    } else {
      throw e;
    }
  }
  const extras = new Uint8Array(await extrasBlob.arrayBuffer());
  onProgress(61.5, "Descargando librerías WASM del juego...");

  const libUrls = [
    assetUrl("/assets/engine/cs16/cs_emscripten_wasm32.wasm"),
    assetUrl("/assets/engine/cs16/client_emscripten_wasm32.wasm"),
    assetUrl("/assets/engine/cs16/menu_emscripten_wasm32.wasm"),
    assetUrl("/assets/engine/cs16/yapb_emscripten_wasm32.wasm"),
  ];
  const results = await Promise.all(
    libUrls.map(async (url) => {
      try {
        const blob = await fetchRetry(url, { cache: "force-cache" }, { onNote });
        return { url, bytes: new Uint8Array(await blob.arrayBuffer()) };
      } catch {
        return null; // optional: local listen server just won't have that lib
      }
    }),
  );
  const libs = results.filter((x): x is { url: string; bytes: Uint8Array<ArrayBuffer> } => x !== null);

  let fsLib: Uint8Array | null = null;
  try {
    const blob = await fetchRetry(assetUrl("/assets/engine/filesystem_stdio.wasm"), { cache: "force-cache" }, { onNote });
    fsLib = new Uint8Array(await blob.arrayBuffer());
  } catch {
    fsLib = null;
  }

  onProgress(63, "Assets auxiliares listos.");
  return { extras, fsLib, libs };
}

export interface MountProgress {
  (pct: number, label: string): void;
}

type EngineFS = {
  mkdirTree: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
};

/**
 * Unzip (streaming) and write every file into the engine FS under /rodir.
 * Performs ZERO network requests — all bytes come from the download phase.
 */
export async function mountGameFiles(
  zipBlob: Blob,
  aux: AuxAssets,
  fs: EngineFS,
  onProgress: MountProgress,
): Promise<void> {
  onProgress(66, "Descomprimiendo archivos del juego (streaming)...");
  fs.mkdirTree("/rodir");
  fs.mkdirTree("/rwdir");

  const EXPECTED_FILES = 5100;
  let count = 0;
  const dirsMade = new Set<string>();
  const ensureDirs = (path: string) => {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !dirsMade.has(dir)) {
      fs.mkdirTree(dir);
      dirsMade.add(dir);
    }
  };
  let zipError: Error | null = null;

  const unzip = new Unzip((file) => {
    // Directory entries end with "/" and carry no data — accept and skip.
    if (file.name.endsWith("/")) {
      file.ondata = () => {};
      file.start();
      return;
    }
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) {
        zipError = new Error(`Error descomprimiendo ${file.name}: ${err.message ?? String(err)}`);
        return;
      }
      if (data) chunks.push(data);
      if (final) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        chunks.length = 0;
        const path = `/rodir/${file.name}`;
        ensureDirs(path);
        fs.writeFile(path, out);
        count++;
        if (count % 100 === 0) {
          onProgress(66 + Math.min(26, (count / EXPECTED_FILES) * 26), `Montando archivos del juego (${count})`);
        }
      }
    };
    file.start();
  });
  // The archive is DEFLATE-compressed; register the streaming decoder.
  unzip.register(UnzipInflate);

  // Stream the (disk-backed) archive blob — never materialise it in RAM.
  const reader = zipBlob.stream().getReader();
  let lastYield = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (zipError) throw zipError;
    unzip.push(value, false);
    if (performance.now() - lastYield > 60) {
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  unzip.push(new Uint8Array(0), true);
  if (zipError) throw zipError;
  onProgress(92, `Archivos del juego montados (${count})`);

  onProgress(93, "Escribiendo extras del cliente CS...");
  fs.mkdirTree("/rodir/cstrike");
  fs.writeFile("/rodir/cstrike/extras.pk3", aux.extras);

  // The engine dlopens a second filesystem_stdio from the rodir for its
  // read-only mount — make the bytes available in the FS for sync loading.
  if (aux.fsLib) {
    onProgress(94, "Preparando filesystem_stdio del motor...");
    fs.writeFile("/rodir/filesystem_stdio.wasm", aux.fsLib);
  }

  // Place the game-logic WASM libraries at every path the engine's dlopen
  // might resolve (liblist.gam names, renamed variants, etc.) so local listen
  // servers can load the server/client libs from the FS synchronously.
  onProgress(94, "Instalando librerías WASM del juego...");
  const byUrl = new Map(aux.libs.map((l) => [l.url, l.bytes]));
  const libJobs: { url: string; paths: string[] }[] = [
    {
      url: assetUrl("/assets/engine/cs16/cs_emscripten_wasm32.wasm"),
      paths: [
        "/rodir/cstrike/dlls/cs_emscripten_wasm32.wasm",
        "/rodir/cstrike/dlls/cs.so",
        "/rodir/cstrike/dlls/server.wasm",
        "/rodir/cstrike/dlls/hl_emscripten_wasm32.wasm",
      ],
    },
    {
      url: assetUrl("/assets/engine/cs16/client_emscripten_wasm32.wasm"),
      paths: [
        "/rodir/cstrike/cl_dlls/client_emscripten_wasm32.wasm",
        "/rodir/cstrike/cl_dlls/client.so",
        "/rodir/cstrike/cl_dlls/client.wasm",
      ],
    },
    {
      url: assetUrl("/assets/engine/cs16/menu_emscripten_wasm32.wasm"),
      paths: ["/rodir/cstrike/cl_dlls/menu_emscripten_wasm32.wasm", "/rodir/cstrike/cl_dlls/menu.so"],
    },
    {
      url: assetUrl("/assets/engine/cs16/yapb_emscripten_wasm32.wasm"),
      paths: ["/rodir/cstrike/addons/yapb/bin/yapb_emscripten_wasm32.wasm", "/rodir/cstrike/dlls/yapb_emscripten_wasm32.wasm"],
    },
  ];
  for (const job of libJobs) {
    const bytes = byUrl.get(job.url);
    if (!bytes) continue;
    for (const p of job.paths) {
      fs.mkdirTree(p.split("/").slice(0, -1).join("/"));
      fs.writeFile(p, bytes);
    }
  }

  onProgress(95, "Montado completado");
  return;
}

export const MAPS = [
  { id: "de_dust2", label: "de_dust2 — Clásico del desierto" },
  { id: "de_dust", label: "de_dust — El original" },
  { id: "de_inferno", label: "de_inferno — Pueblo europeo" },
  { id: "de_nuke", label: "de_nuke — Planta nuclear" },
  { id: "de_train", label: "de_train — Patio de trenes" },
  { id: "de_prodigy", label: "de_prodigy — Base militar" },
  { id: "de_cbble", label: "de_cbble — Castillo" },
  { id: "de_aztec", label: "de_aztec — Ruinas aztecas" },
  { id: "de_vertigo", label: "de_vertigo — Rascacielos" },
  { id: "cs_office", label: "cs_office — Oficinas (rehenes)" },
  { id: "cs_assault", label: "cs_assault — Almacén (rehenes)" },
  { id: "cs_italy", label: "cs_italy — Mercado (rehenes)" },
  { id: "cs_militia", label: "cs_militia — Granja (rehenes)" },
  { id: "cs_backalley", label: "cs_backalley — Callejones" },
];
