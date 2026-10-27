#!/usr/bin/env python3
"""Analyze valve.zip contents and build a lite version (skip HL single-player content), re-split into parts."""
import json, zipfile, io, os, hashlib

PARTS_DIR = "/home/z/my-project/public/valve-parts"
FULL_MANIFEST = os.path.join(PARTS_DIR, "manifest.json")

# 1. read parts and rebuild full zip in memory
m = json.load(open(FULL_MANIFEST))
buf = bytearray()
for i in range(m["partCount"]):
    with open(os.path.join(PARTS_DIR, f"valve.part-{i:03d}"), "rb") as f:
        buf += f.read()
assert hashlib.sha256(buf).hexdigest() == m["archiveSha256"], "hash mismatch"
zf = zipfile.ZipFile(io.BytesIO(bytes(buf)))

# 2. analyze
from collections import defaultdict
sizes = defaultdict(int)
counts = defaultdict(int)
for info in zf.infolist():
    if info.is_dir():
        continue
    top = "/".join(info.filename.split("/")[:2])
    sizes[top] += info.file_size
    counts[top] += 1
print("=== top dirs by size (MB) ===")
for k, v in sorted(sizes.items(), key=lambda x: -x[1])[:25]:
    print(f"{v/1e6:9.1f}MB  {counts[k]:5d}  {k}")
