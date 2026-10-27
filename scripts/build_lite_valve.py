#!/usr/bin/env python3
"""Build lite valve.zip (skip HL SP content + native dlls) and re-split into 8MB parts."""
import json, zipfile, io, os, hashlib, shutil

PARTS_DIR = "/home/z/my-project/public/valve-parts"
FULL_MANIFEST = os.path.join(PARTS_DIR, "manifest.json")
OUT_DIR = "/home/z/my-project/public/valve-parts-lite"
PART_SIZE = 8 * 1024 * 1024

EXCLUDE_PREFIXES = (
    "valve/maps/",
    "valve/media/",
    "valve/overviews/",
    "valve/save/",
    "valve/downloads/",
    "valve/logs/",
    "cstrike/dlls/",
    "cstrike/cl_dlls/",
)
EXCLUDE_NAMES = {"valve/halflife.wad"}

m = json.load(open(FULL_MANIFEST))
buf = bytearray()
for i in range(m["partCount"]):
    with open(os.path.join(PARTS_DIR, f"valve.part-{i:03d}"), "rb") as f:
        buf += f.read()
assert hashlib.sha256(buf).hexdigest() == m["archiveSha256"]
zf = zipfile.ZipFile(io.BytesIO(bytes(buf)))

out = io.BytesIO()
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    kept, dropped = 0, 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        fn = info.filename
        if fn.startswith(EXCLUDE_PREFIXES) or fn in EXCLUDE_NAMES:
            dropped += 1
            continue
        z.writestr(fn, zf.read(fn))
        kept += 1
print(f"kept {kept}, dropped {dropped}, lite zip: {len(out.getvalue())/1e6:.1f}MB")

data = out.getvalue()
sha = hashlib.sha256(data).hexdigest()
os.makedirs(OUT_DIR, exist_ok=True)
for f in os.listdir(OUT_DIR):
    os.remove(os.path.join(OUT_DIR, f))

parts = []
count = (len(data) + PART_SIZE - 1) // PART_SIZE
for i in range(count):
    chunk = data[i * PART_SIZE:(i + 1) * PART_SIZE]
    name = f"valve.part-{i:03d}"
    with open(os.path.join(OUT_DIR, name), "wb") as f:
        f.write(chunk)
    parts.append({"file": name, "size": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})

manifest = {
    "source": "CS 1.6 Web Port - trimmed (no HL single-player content, no native dlls)",
    "archive": "valve.zip",
    "archiveSize": len(data),
    "archiveSha256": sha,
    "partSize": PART_SIZE,
    "partCount": count,
    "parts": parts,
}
with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print(f"parts: {count}, manifest written to {OUT_DIR}")
