# ---------------------------------------------------------------------------
# CS 1.6 Web Port — Render service image (bridge WebSocket⇄UDP + HLDS)
#
# Both base images are pinned by digest. The GoldSrc image supplies the
# reproducible CS 1.6 content tree; MetaMod-P, ReGameDLL, and YaPB are fetched
# from immutable release URLs and verified with SHA-256 before installation.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS bun

FROM lacledeslan/gamesvr-goldsource-cstrike@sha256:bef58b164d481adfcc363429e58f22f295548d320438b94359b18352a322dcdc

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ARG METAMODP_VERSION=v1.21p109
ARG METAMODP_SHA256=3b77d804cd5687ee18a8535ec02d085e42c9d0da1c12a0683c6aeb25e88d3e1e
ARG REGAMEDLL_VERSION=5.30.0.814
ARG REGAMEDLL_SHA256=457f5c96a4d10280fcad47f106cbd5be86363a47df1ccab91c514e9d1bc6fd18
ARG YAPB_VERSION=4.4.957
ARG YAPB_SHA256=8c095ac89b9b2ccc70a66a71d608e1a570b5268c57c6083ced8c06161533a4b1

# Loader chain:
#   liblist.gam → MetaMod-P → ReGameDLL (dlls/cs.so)
#                              ↘ YaPB (MetaMod plugin)
#
# Remove the upstream AMX Mod X and obsolete jk_botti trees: YaPB is the only
# bot provider, and AMX is neither required nor wanted in this deployment.
RUN set -eux; \
    work="$(mktemp -d)"; \
    curl --fail --location --retry 3 \
      "https://github.com/Bots-United/metamod-p/releases/download/${METAMODP_VERSION}/metamod-p-${METAMODP_VERSION}-linux_ubuntu1804.tar.xz" \
      --output "$work/metamod-p.tar.xz"; \
    printf '%s  %s\n' "${METAMODP_SHA256}" "$work/metamod-p.tar.xz" | sha256sum --check --strict; \
    rm -rf /app/cstrike/addons/metamod; \
    tar -xJf "$work/metamod-p.tar.xz" -C /app/cstrike; \
    curl --fail --location --retry 3 \
      "https://github.com/rehlds/ReGameDLL_CS/releases/download/${REGAMEDLL_VERSION}/regamedll-bin-${REGAMEDLL_VERSION}.zip" \
      --output "$work/regamedll.zip"; \
    printf '%s  %s\n' "${REGAMEDLL_SHA256}" "$work/regamedll.zip" | sha256sum --check --strict; \
    unzip -q "$work/regamedll.zip" -d "$work/regamedll"; \
    install -m 0755 "$work/regamedll/bin/linux32/cstrike/dlls/cs.so" /app/cstrike/dlls/cs.so; \
    install -m 0644 "$work/regamedll/bin/linux32/cstrike/game.cfg" /app/cstrike/game.cfg; \
    install -m 0644 "$work/regamedll/bin/linux32/cstrike/game_init.cfg" /app/cstrike/game_init.cfg; \
    curl --fail --location --retry 3 \
      "https://github.com/yapb/yapb/releases/download/${YAPB_VERSION}/yapb-${YAPB_VERSION}-linux.tar.xz" \
      --output "$work/yapb.tar.xz"; \
    printf '%s  %s\n' "${YAPB_SHA256}" "$work/yapb.tar.xz" | sha256sum --check --strict; \
    tar -xJf "$work/yapb.tar.xz" -C /app/cstrike; \
    rm -rf \
      /app/cstrike/addons/amxmodx \
      /app/cstrike/addons/jk_botti; \
    sed -i -E 's#^gamedll_linux[[:space:]].*#gamedll_linux "addons/metamod/dlls/metamod.so"#' /app/cstrike/liblist.gam; \
    printf '%s\n' \
      'gamedll dlls/cs.so' \
      'plugins_file addons/metamod/plugins.ini' \
      'exec_cfg addons/metamod/exec.cfg' \
      > /app/cstrike/addons/metamod/config.ini; \
    printf '%s\n' 'linux addons/yapb/bin/yapb.so' > /app/cstrike/addons/metamod/plugins.ini; \
    chmod 0755 /app/cstrike/addons/metamod/dlls/metamod.so /app/cstrike/addons/yapb/bin/yapb.so; \
    rm -f /app/cstrike/addons/metamod/dlls/trace_mm.so; \
    chown -R CStrike:root \
      /app/cstrike/addons/metamod \
      /app/cstrike/addons/yapb \
      /app/cstrike/dlls/cs.so \
      /app/cstrike/game.cfg \
      /app/cstrike/game_init.cfg; \
    rm -rf "$work"

# The WebSocket⇄UDP bridge is also the HLDS supervisor. The entrypoint
# generates the runtime-owned server configuration before Bun starts.
COPY --chown=CStrike:root mini-services/cs16-server /app/bridge
COPY --chown=CStrike:root --chmod=0755 deploy/render/entrypoint.sh /app/bridge/entrypoint.sh

ENV NODE_ENV=production \
    PORT=10000 \
    HLDS_DIR=/app \
    HLDS_GAME_DIR=/app/cstrike \
    HLDS_LOG_FILE=/tmp/hlds-supervised.log \
    HLDS_MAP=de_dust2 \
    HLDS_MAXPLAYERS=16 \
    HLDS_BOT_QUOTA=9 \
    QEMU=

EXPOSE 10000

USER CStrike
WORKDIR /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl --fail --silent "http://127.0.0.1:${PORT}/health" | grep --quiet '"hlds":true' || exit 1

CMD ["/app/bridge/entrypoint.sh"]
