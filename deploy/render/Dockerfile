# ---------------------------------------------------------------------------
# CS 1.6 Web Port — Render service image (bridge WebSocket⇄UDP + HLDS nativo)
#
# Build context: the repository ROOT (see deploy/render/render.yaml):
#   docker build -f deploy/render/Dockerfile .
#
# The sandbox ran HLDS under qemu-i386 because it is an ARM host. Render
# machines are x86_64, so HLDS runs NATIVE here: faster and simpler — we only
# need the 32-bit runtime libraries (libc6-i386 + friends).
# ---------------------------------------------------------------------------
FROM oven/bun:1-debian

# 32-bit runtime for the 32-bit HLDS binary + ca-certs for outbound HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libc6-i386 \
        lib32stdc++6 \
        lib32gcc-s1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Real CS 1.6 dedicated server (ReGameDLL + YaPB already installed inside).
COPY hlds-ns-root /app/hlds-ns-root

# The WebSocket⇄UDP bridge (also the HLDS supervisor).
COPY mini-services/cs16-server /app/bridge

ENV NODE_ENV=production \
    PORT=10000 \
    HLDS_DIR=/app/hlds-ns-root/opt/steam/hlds \
    HLDS_LOG_FILE=/tmp/hlds-supervised.log \
    HLDS_MAP=de_dust2 \
    HLDS_MAXPLAYERS=16 \
    # Empty QEMU => native 32-bit execution (x86_64 host).
    QEMU=

EXPOSE 10000

# The bridge probes HLDS, spawns it if needed, then serves /health, /logs
# and the WebSocket tunnel on $PORT.
CMD ["bun", "run", "/app/bridge/index.ts"]
