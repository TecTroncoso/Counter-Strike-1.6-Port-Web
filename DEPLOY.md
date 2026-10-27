# DEPLOY.md — Despliegue: Cloudflare + Render + Turso

Guía completa para llevar el proyecto del sandbox a producción con el stack:

```
Navegador ──HTTPS──▶ Cloudflare Workers (frontend OpenNext + Static Assets)
    │
    └──WSS──▶ Render (Docker: puente Bun WebSocket⇄UDP + HLDS nativo 32-bit + bots YaPB)
                 └── UDP localhost:27015 ──▶ HLDS (de_dust2)

Turso (libSQL) ◀── Prisma driver adapter ── Cloudflare Workers
```

Coste recomendado: **$7/mes** (Render Starter, siempre encendido). También
puede probarse con Render Free + un cron externo, pero el servicio se duerme
tras 15 min sin tráfico y el primer juego necesita esperar al arranque.

### Estado desplegado actual

| Componente | URL pública | Estado |
|---|---|---|
| Frontend Next.js | <https://cs16-web.counterstrike.workers.dev> | Live en Cloudflare Workers |
| Puente WSS + HLDS | <https://cs16-hlds-bridge.onrender.com> | Live en Render (`de_dust2`, 9 bots) |

El servicio Render actual usa el plan temporal **Free** porque la cuenta todavía
no tiene un método de pago. Para producción-resident se debe añadir la
facturación y cambiar a **Starter**; Render devuelve `402 Payment Required`
mientras no exista información de pago. Free sigue siendo válido para validar
el flujo, pero puede dormirse tras 15 min sin tráfico.

Por qué funciona este reparto:

| Pieza | Dónde | Por qué ahí |
|---|---|---|
| Frontend Next.js | Cloudflare (OpenNext) | El launcher es client-side; Workers gratis sobra |
| 284 MB de assets del juego | Cloudflare Static Assets (R2 opcional) | El conjunto actual son 42 archivos y el mayor está por debajo del límite de 25 MiB; R2 puede usarse después si se requieren descargas Range/resumibles |
| Puente WS⇄UDP + HLDS | Render (Docker) | Proceso persistente; el navegador SOLO habla WSS con el puente — HLDS escucha UDP en localhost dentro del contenedor, así que Render no necesita UDP público |
| Base de datos | Turso | Prisma + adapter libSQL (ya integrado en `src/lib/db.ts`) |

---

## 0. Prerrequisitos

```bash
# Herramientas locales
curl -fsSL https://bun.sh/install | bash        # bun (runtime + deploy tools)
bunx wrangler login                              # Cloudflare (abre el navegador)
curl -sSL https://cli.turso.io/install | sh      # Turso CLI
turso auth login                                 # Turso (abre el navegador)
```

Cuentas: [Cloudflare](https://dash.cloudflare.com) (gratis),
[Render](https://dashboard.render.com), [Turso](https://dashboard.turso.io) (gratis).

Sube el repo a GitHub (Render y Cloudflare despliegan desde Git; también
puedes usar `wrangler deploy` directo).

---

## 1. Turso — base de datos

```bash
turso db create cs16 --location mad                # elige tu región
turso db show cs16 --url                           # → TURSO_DATABASE_URL
turso db tokens create cs16                        # → TURSO_AUTH_TOKEN

# Aplica el esquema Prisma (genera el SQL del esquema y lo ejecuta en Turso):
bunx prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  | turso db shell cs16
```

Guarda `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` para el paso 3.

> Nota: en local NO hace falta Turso. Si `TURSO_DATABASE_URL` no está definido,
> `src/lib/db.ts` usa el SQLite local de siempre (modo sandbox).

---

## 2. Render — puente WebSocket⇄UDP + HLDS

La imagen Docker de `deploy/render/Dockerfile` usa como base la imagen GoldSrc
oficial fijada por digest (`lacledeslan/gamesvr-goldsource-cstrike`). La imagen
final añade MetaMod-P, ReGameDLL_CS y YaPB desde releases inmutables, verifica
sus SHA-256 y genera la configuración del servidor al arrancar. **En Render
(x86_64) HLDS corre NATIVO, sin qemu**.

No hace falta subir `hlds-ns-root/` al repositorio ni usar Git LFS: el contexto
de build solo contiene el puente y el entrypoint (`.dockerignore` excluye el
resto). El servidor, sus mapas y las librerías 32-bit ya están en la imagen base.

**Opción A (Blueprint, recomendada):** en Render → *New → Blueprint* → repo →
selecciona `deploy/render/render.yaml` → *Apply*. El plan `starter` mantiene el
servidor residente.

Durante el Apply, configura lo siguiente:

- `BRIDGE_ALLOWED_ORIGINS`: el origen exacto del frontend, separado por comas
  si hay varios (por ejemplo `https://cs16-web.example.dev`). En producción el
  puente rechaza cualquier origen que no esté en esta lista.
- `HLDS_RCON_PASSWORD`: Render genera un secreto aleatorio. El servidor lo usa
  para habilitar RCON y el diagnóstico local puede reutilizarlo; no se devuelve
  en `/health` ni se envía al navegador.

**Opción B (manual):** Render → *New → Web Service* → repo conectado:

| Campo | Valor |
|---|---|
| Runtime | Docker |
| Dockerfile path | `deploy/render/Dockerfile` |
| Docker build context | `.` (raíz del repo) |
| Health check path | `/health` |
| Instance type | Starter (recomendado) |

Configura también `BRIDGE_ALLOWED_ORIGINS` y `HLDS_RCON_PASSWORD` como secretos.
Las demás variables vienen en el Dockerfile y se pueden sobrescribir:
`HLDS_DIR=/app`, `HLDS_GAME_DIR=/app/cstrike`, `HLDS_MAP=de_dust2`,
`HLDS_MAXPLAYERS=16`, `HLDS_BOT_QUOTA=9` y `QEMU=` (vacío).

Al terminar tendrás `https://cs16-hlds-bridge.onrender.com`. Verifica:

```bash
curl https://cs16-hlds-bridge.onrender.com/health
# {"hlds":true,"starts":1,"uptimeSec":…,"clients":0,…}   ← hlds:true = HLDS vivo
```

Los logs del HLDS y del supervisor están en el dashboard de Render; no existe un
endpoint HTTP público de logs. El repositorio incluye
`.github/workflows/render-smoke.yml`, que construye la imagen y comprueba el
servidor real (RCON, MetaMod-P, ReGameDLL, YaPB, CORS, WebSocket y reinicio).

---

## 3. Cloudflare — Worker con OpenNext + Static Assets

### 3a. Assets del juego

El build copia `game-files/` a `.open-next/assets/assets/`; así el Worker los
publica en `/assets/...`. El conjunto actual contiene 42 archivos (unos 284 MB)
y el mayor ocupa menos de 25 MiB, el límite por archivo de Cloudflare Static
Assets. El launcher descarga cada parte de 8 MB por separado, por lo que no
necesita respuestas HTTP Range.

R2 es una opción futura si quieres descargas Range/resumibles o CDN propio:

```bash
bun run deploy:r2                      # sube game-files/ → r2://cs16-assets/assets/…
```

Luego configura el acceso público y CORS del bucket y usa su URL como
`NEXT_PUBLIC_ASSETS_BASE_URL`. Mientras tanto, déjalo vacío para servir los
assets desde el propio Worker.

### 3b. Workers: el frontend con OpenNext

Crea `.env` (o configura las variables en el dashboard al desplegar):

```bash
NEXT_PUBLIC_CS16_BRIDGE_URL=wss://cs16-hlds-bridge.onrender.com
NEXT_PUBLIC_ASSETS_BASE_URL=
```

Los secretos de Turso se configuran aparte como secrets de runtime del Worker
(no se incluyen en el bundle):

```bash
bunx wrangler secret put TURSO_DATABASE_URL
bunx wrangler secret put TURSO_AUTH_TOKEN
```

Despliega:

```bash
bun run deploy:cf      # build sanitizado + auditoría de secretos + deploy
```

> Las variables `NEXT_PUBLIC_*` se **inlinean en build time**: si las cambias,
> redespliega. `scripts/build-cloudflare.mjs` permite incluir únicamente esas
> variables públicas en el artefacto y verifica que ningún secreto local haya
> quedado embebido.

Verifica: abre la URL del Worker (`https://cs16-web.<tu-subdomain>.workers.dev`),
el menú debe mostrar el estado del servidor en verde (viene de
`NEXT_PUBLIC_CS16_BRIDGE_URL/health` con CORS ya habilitado en el puente).

**Dominio propio**: en Cloudflare → Workers → cs16-web → Settings → Domains →
*Add custom domain* si quieres `jugar.tudominio.com`.

---

## 4. Plan gratuito — opcional

El Blueprint usa **Starter** porque un servidor multijugador debe permanecer
residente y arrancar sin esperar una desconexión de inactividad. Si quieres
probarlo sin pagar, puedes cambiar el plan a `free` en Render:

- Render free **duerme el servicio tras 15 min sin tráfico HTTP**. El primer
  jugador tras el sleep esperaría el arranque del contenedor, HLDS y bots.
- Puedes usar [cron-job.org](https://cron-job.org) → *Cronjobs → Create cronjob*
  con la URL `https://cs16-hlds-bridge.onrender.com/health`, método `GET` y
  frecuencia de 10 minutos para reducir los sleeps.
- El cron no evita reinicios por deploy/crash. El supervisor integrado vuelve a
  arrancar HLDS y a restaurar la cuota de bots.

Para producción se recomienda Starter: evita sleeps, reinicios programados y
dependencias externas. No hace falta un disco persistente: los archivos del
juego viven en la imagen y la configuración se regenera en cada arranque.

---

## 5. Flujo final y verificación

```bash
# 1. Render vivo
curl https://cs16-hlds-bridge.onrender.com/health

# 2. Assets servidos por Cloudflare Static Assets
curl -sI https://cs16-web.<subdomain>.workers.dev/assets/engine/xash.wasm \
  | grep -i "content-type\|content-length"

# 3. Frontend
#    abre https://cs16-web.<subdomain>.workers.dev → Jugar →
#    la barra debe llegar a 100% y conectar al túnel WSS.
```

---

## 6. Troubleshooting

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| El menú queda en "servidor desconectado" | `NEXT_PUBLIC_CS16_BRIDGE_URL` mal escrito o Render dormido | Verifica la URL en la consola del navegador (`/health` 404/net::ERR); despierta Render o revisa el deploy |
| Descarga de assets al 0% con error CORS | URL de assets mal configurada | Si `NEXT_PUBLIC_ASSETS_BASE_URL` está vacío, los assets salen del propio Worker; si no, revisa CORS y la URL del bucket |
| Se necesita reanudar una descarga parcial | Static Assets sirve el archivo completo | Configura R2 y `NEXT_PUBLIC_ASSETS_BASE_URL`; el loader ya descarga partes independientes de 8 MB y verifica SHA-256 |
| WSS no conecta, consola: "Mixed Content" | Frontend en HTTPS hablando `ws://` | Usa `wss://` en `NEXT_PUBLIC_CS16_BRIDGE_URL` |
| `/health` responde `hlds:false` permanente | HLDS no arranca en el contenedor | Revisa los Logs de Render; confirma `QEMU` vacío, `HLDS_DIR=/app` y que el mapa exista en la imagen base |
| El navegador recibe `403 Origin not allowed` | `BRIDGE_ALLOWED_ORIGINS` no coincide con el origen real | Configura el origen exacto del frontend (esquema + host + puerto, sin ruta) y redeploya |
| El build falla al descargar un componente | Red o release no disponible | El Dockerfile reintenta las descargas y verifica SHA-256; revisa la URL del release en los logs |
| "Setting up renderer…" en bucle | El túnel WS no transporta UDP (puente caído o URL incorrecta) | Revisa `packetsIn` en `/health` y los Logs de Render; no existe `/logs` público |
| Turso: "no such table" | Esquema no aplicado | Repite el `prisma migrate diff | turso db shell` del §1 |
| Workers: error 1101 al abrir | Falta `nodejs_compat` o binding de assets | Verifica `wrangler.jsonc` (§3b) |

---

## 7. Qué se adaptó en el código para este despliegue

- `mini-services/cs16-server/index.ts` — paths y modo de ejecución por env vars
  (`HLDS_DIR`, `QEMU`, `SYSROOT`, `HLDS_PORT`, `HLDS_LOG_FILE`, `HLDS_MAP`,
  `HLDS_MAXPLAYERS`, `HLDS_BOT_QUOTA`), supervisor con reintentos, CORS con
  allow-list de origen y health sin secretos; ya no expone `/logs`.
- `deploy/render/entrypoint.sh` — valida la configuración, genera `server.cfg`,
  aplica el RCON secreto, fija `yb_quota` en MetaMod y en la config principal de
  YaPB, y crea un ciclo de un solo mapa.
- `deploy/render/Dockerfile` — base GoldSrc fijada por digest más MetaMod-P,
  ReGameDLL y YaPB con releases/SHA-256 verificados.
- `deploy/render/render.yaml` + `.github/workflows/render-smoke.yml` — Blueprint
  con Starter, secretos gestionados por Render y prueba E2E del contenedor.
- `src/lib/cs16/bridge.ts` (nuevo) — `bridgeHttpUrl` / `bridgeWsUrl` /
  `assetUrl`: honran `NEXT_PUBLIC_CS16_BRIDGE_URL` y
  `NEXT_PUBLIC_ASSETS_BASE_URL`; sin ellas el comportamiento es idéntico al
  original (same-origin + gateway Caddy).
- `src/lib/cs16/engine.ts` + `loader.ts` — las 21 URLs de assets pasan por
  `assetUrl()`.
- `src/lib/db.ts` — si `TURSO_DATABASE_URL` está definido usa el adapter
  `@prisma/adapter-libsql`; si no, SQLite local (sin cambios en el sandbox).
- `deploy/render/` — Dockerfile + blueprint de Render (HLDS nativo).
- `wrangler.jsonc` + `open-next.config.ts` — despliegue Cloudflare.
- `scripts/build-cloudflare.mjs` — build OpenNext con allowlist pública y
  auditoría de secretos; `scripts/prepare-cloudflare-assets.mjs` copia los
  assets del juego a Worker Static Assets.
- `scripts/upload_r2.sh` — subida opcional de los 284 MB a R2 bajo `assets/`.
