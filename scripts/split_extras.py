#!/usr/bin/env python3
"""
Split game-files/engine/cs16/extras.pk3 into 8 MB parts + manifest.json
(same schema as valve-parts) so the browser can download it in chunks that
survive the preview gateway's per-response size limits.
"""
import hashlib
import json
import os

SRC = "/home/z/my-project/game-files/engine/cs16/extras.pk3"
OUT_DIR = "/home/z/my-project/game-files/engine/cs16/extras-parts"
PART_SIZE = 8 * 1024 * 1024  # 8 MB — the size proven to pass the gateway


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main() -> None:
    total = os.path.getsize(SRC)
    archive_sha = sha256_file(SRC)
    os.makedirs(OUT_DIR, exist_ok=True)

    parts = []
    idx = 0
    with open(SRC, "rb") as f:
        while True:
            data = f.read(PART_SIZE)
            if not data:
                break
            name = f"extras.part-{idx:03d}"
            out = os.path.join(OUT_DIR, name)
            with open(out, "wb") as g:
                g.write(data)
            parts.append({
                "file": name,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })
            print(f"{name}: {len(data)} bytes")
            idx += 1

    manifest = {
        "source": "CS 1.6 Web Port - extras.pk3 split (gateway-safe 8 MB parts)",
        "archive": "extras.pk3",
        "archiveSize": total,
        "archiveSha256": archive_sha,
        "partSize": PART_SIZE,
        "partCount": len(parts),
        "parts": parts,
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"OK: {len(parts)} parts, {total} bytes total, sha256={archive_sha[:16]}...")


if __name__ == "__main__":
    main()
