import { NextRequest } from "next/server";
import { createReadStream, promises as fs } from "fs";
import { Readable } from "stream";
import path from "path";

/**
 * Static file server for the big CS 1.6 game binaries, kept outside /public
 * so the Tailwind/Turbopack scanners never touch them.
 * Serves /assets/engine/** and /assets/valve-parts/** from ./game-files.
 *
 * Streams from disk (never buffers a whole 8-25 MB file in RAM) and supports
 * HTTP Range requests so interrupted transfers can be resumed and the browser
 * cache can validate cheaply.
 */

const ROOT = path.join(process.cwd(), "game-files");

const MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".pk3": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
};

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  return "application/octet-stream";
}

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  const rel = segments.map(decodeURIComponent).join("/");
  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    return new Response("Forbidden", { status: 403 });
  }

  let stat;
  try {
    stat = await fs.stat(target);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    "content-type": mimeFor(target),
    "accept-ranges": "bytes",
    etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    "cache-control": "public, max-age=86400, immutable",
    "access-control-allow-origin": "*",
  };

  // Single-range support (browsers use it to resume interrupted bodies).
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start: number;
      let end: number;
      if (m[1] === "" && m[2] !== "") {
        // suffix range: last N bytes
        const suffix = parseInt(m[2], 10);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] !== "" ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}` },
        });
      }
      return new Response(toWebStream(createReadStream(target, { start, end })), {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "content-length": String(end - start + 1),
        },
      });
    }
  }

  return new Response(toWebStream(createReadStream(target)), {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(stat.size) },
  });
}
