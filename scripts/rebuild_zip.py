#!/usr/bin/env python3
"""Rebuilds the downloadable project zip (cs16-web-port-deploy-kit.zip).

Same scope as the previous delivery (cs16-web-port.zip), updated with the
Cloudflare + Render + Turso deployment kit:
 - deploy/ (Render Dockerfile + blueprint), wrangler.jsonc, open-next.config.ts
 - DEPLOY.md (paso a paso: CF + Render + Turso + cron-job.org anti-sleep)
 - bridge con env vars/CORS/auto qemu-nativo, assetUrl helper, adaptador Turso

Excluded: node_modules, .next, .git, dev.log, download/, hlds-ns-root,
scripts/.cdp-profile* (Chrome test profiles ~205 MB).
"""
import os
import zipfile
import time

ROOT = "/home/z/my-project"
OUT = "/home/z/my-project/download/cs16-web-port-deploy-kit.zip"

DIRS = ["src", "game-files", "scripts", "mini-services", "examples", "tests",
        "public", "db", "prisma", "deploy"]
ROOT_FILES = [
    "README.md", "next.config.ts", "package.json", "postcss.config.mjs",
    "tsconfig.json", "bun.lock", "tailwind.config.ts", "Caddyfile",
    "worklog.md", "components.json", "next-env.d.ts", ".gitignore",
    "eslint.config.mjs", ".env.example", "DEPLOY.md", "wrangler.jsonc",
    "open-next.config.ts", ".dockerignore", ".env.deploy.example",
]
EXCLUDE_DIR_PARTS = {"node_modules", ".next", ".git", "download", "hlds-ns-root",
                     "agent-ctx", "skills"}
EXCLUDE_PREFIXES = (".cdp-profile",)  # Chrome test profiles (~200 MB cada uno)
EXCLUDE_FILES = {"dev.log", "cs16-web-port.zip", "cs16-web-port-deploy-kit.zip"}


def excluded(rel: str) -> bool:
    parts = rel.split(os.sep)
    if any(p in EXCLUDE_DIR_PARTS or p.startswith(EXCLUDE_PREFIXES) for p in parts[:-1]):
        return True
    if os.path.basename(rel) in EXCLUDE_FILES:
        return True
    if os.path.basename(rel).endswith((".pyc", ".log.tmp")):
        return True
    return False


def main() -> None:
    files = []
    for d in DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, dirnames, filenames in os.walk(base):
            # prune excluded subdirs in-place
            dirnames[:] = [x for x in dirnames if x not in EXCLUDE_DIR_PARTS]
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
                if not excluded(rel):
                    files.append(rel)
    for fn in ROOT_FILES:
        p = os.path.join(ROOT, fn)
        if os.path.isfile(p):
            files.append(fn)
    files.sort()

    total = sum(os.path.getsize(os.path.join(ROOT, f)) for f in files)
    print(f"entries: {len(files)}  raw: {total/1e6:.1f} MB")

    t0 = time.time()
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in files:
            z.write(os.path.join(ROOT, rel), arcname=rel)
    size = os.path.getsize(OUT)
    print(f"wrote {OUT}: {size/1e6:.1f} MB in {time.time()-t0:.1f}s")

    # verification pass
    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        assert bad is None, f"corrupt entry: {bad}"
        names = z.namelist()
        for probe in ("src/lib/cs16/engine.ts", "src/app/page.tsx",
                      "src/lib/cs16/bridge.ts",
                      "game-files/valve-parts/manifest.json",
                      "scripts/buy_test.js", "scripts/rcon.py",
                      "scripts/look_test.js", "scripts/diag_look.js",
                      "scripts/upload_r2.sh",
                      "deploy/render/Dockerfile", "deploy/render/render.yaml",
                      "wrangler.jsonc", "open-next.config.ts", "DEPLOY.md",
                      "worklog.md", "Caddyfile"):
            info = z.getinfo(probe)
            print(f"  ok {probe} ({info.file_size} B)")
        page_src = z.read("src/app/page.tsx").decode("utf8")
        assert 'id="canvas"' in page_src, "page.tsx sin el fix del id del canvas!"
        assert "nolookfix" in page_src or "rewrite" in page_src, "page.tsx sin rewriter!"
        assert "bridgeHttpUrl" in page_src, "page.tsx sin helper del puente!"
        eng_src = z.read("src/lib/cs16/engine.ts").decode("utf8")
        assert "setRelativeMouse" in eng_src and "m_rawinput" in eng_src, \
            "engine.ts sin los fixes de ratón!"
        assert "assetUrl" in eng_src, "engine.ts sin helper de assets!"
        bridge_src = z.read("mini-services/cs16-server/index.ts").decode("utf8")
        assert "QEMU_CANDIDATE" in bridge_src and "access-control-allow-origin" in bridge_src, \
            "puente sin auto-detección qemu ni CORS!"
        db_src = z.read("src/lib/db.ts").decode("utf8")
        assert "PrismaLibSQL" in db_src, "db.ts sin adaptador Turso!"
        assert not any(".cdp-profile" in n for n in names), "perfil CDP dentro del zip!"
        top = {}
        for n in names:
            top[n.split("/")[0]] = top.get(n.split("/")[0], 0) + 1
        print("  sections:", dict(sorted(top.items())))
    print("ZIP OK")


if __name__ == "__main__":
    main()
