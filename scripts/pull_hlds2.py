#!/usr/bin/env python3
"""Pull lacledeslan/gamesvr-goldsource-cstrike image layers and extract them."""
import json, os, sys, tarfile, urllib.request

REPO = "artkirienko/hlds"
REGISTRY = "https://registry-1.docker.io"
DEST = "/home/z/my-project/hlds-ns-root"
LAYERS_DIR = "/home/z/my-project/compat/layers"

os.makedirs(LAYERS_DIR, exist_ok=True)
os.makedirs(DEST, exist_ok=True)

token = open("/tmp/dh2.token").read().strip()
manifest = json.load(open("/tmp/m2.json"))

def get(url, dest=None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        if dest:
            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            return None
        return r.read()

layers = manifest["layers"]
print(f"pulling {len(layers)} layers...", flush=True)
for i, l in enumerate(layers):
    dig, size = l["digest"], l["size"]
    if size < 1000:
        continue
    fn = os.path.join(LAYERS_DIR, dig.replace(":", "_") + ".tar.gz")
    if not os.path.exists(fn) or os.path.getsize(fn) != size:
        print(f"[{i+1}/{len(layers)}] downloading {dig[:26]} {round(size/1e6,1)}MB", flush=True)
        get(f"{REGISTRY}/v2/{REPO}/blobs/{dig}", fn)
    print(f"[{i+1}/{len(layers)}] extracting...", flush=True)
    mode = "r:gz" if fn.endswith(".gz") else "r"
    with tarfile.open(fn, mode) as t:
        try:
            t.extractall(DEST, filter="data")
        except Exception as e:
            print("  extract warn:", e, flush=True)
    print(f"[{i+1}/{len(layers)}] done", flush=True)

print("ALL LAYERS EXTRACTED", flush=True)
