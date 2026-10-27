# DEPLOY.md — Despliegue: Cloudflare + Render + Turso (+ cron-job.org)

Guía completa para llevar el proyecto del sandbox a producción con el stack:

```
Navegador ──HTTPS──▶ Cloudflare Workers (frontend OpenNext) + R2 (271 MB de assets)
    │
    └──WSS──▶ Render (Docker: puente Bun WebSocket⇄UDP + HLDS nativo 32-bit + bots YaPB)
                 └── UDP localhost:27015 ──▶ HLDS (de_dust2)

Turso (libSQL) ◀── Prisma driver adapter ── Cloudflare Workers
cron-job.org ── GET /health cada 10 min ──▶ Render (anti-sleep)
```

Coste: **$0/mes** (Render free + cron-job.org) o **$7/mes** (Render Starter,
siempre encendido y sin depender del cron).

Por qué funciona este reparto:

| Pieza | Dónde | Por qué ahí |
|---|---|---|
| Frontend Next.js | Cloudflare (OpenNext) | El launcher es client-side; Workers gratis sobra |
| 271 MB de assets del juego | R2 público | La API route `/assets` lee del disco → no existe en Workers; R2 soporta Range y sin límite de 25 MB/archivo |
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
[Render](https://dashboard.render.com) (gratis), [Turso](https://dashboard.turso.io) (gratis),
[cron-job.org](https://cron-job.org) (gratis).

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

La imagen Docker ya está preparada en `deploy/render/Dockerfile`: Debian + Bun +
`libc6-i386`, con el servidor real (1.1 GB, `hlds-ns-root/`) incrustado. **En
Render (x86_64) HLDS corre NATIVO, sin qemu** — el mismo `index.ts` detecta la
arquitectura y elige el modo automáticamente.

**Opción A (Blueprint):** en Render → *New → Blueprint* → repo → detecta
`deploy/render/render.yaml` → Apply.

**Opción B (manual):** Render → *New → Web Service* → repo conectado:

| Campo | Valor |
|---|---|
| Runtime | Docker |
| Dockerfile path | `deploy/render/Dockerfile` |
| Docker build context | `.` (raíz del repo) |
| Health check path | `/health` |
| Instance type | Free (ver §4) o Starter $7/mes |

Env vars (ya vienen en el Dockerfile, puedes sobreescribirlas): `HLDS_DIR`,
`HLDS_LOG_FILE`, `HLDS_MAP=de_dust2`, `HLDS_MAXPLAYERS=16`, `QEMU=` (vacío).

Al terminar tendrás `https://cs16-hlds-bridge.onrender.com`. Verifica:

```bash
curl https://cs16-hlds-bridge.onrender.com/health
# {"hlds":true,"starts":1,"uptimeSec":…,"clients":0,…}   ← hlds:true = HLDS vivo
```

> **Atención al contexto de build:** la imagen incrusta `hlds-ns-root/`
> (1.1 GB). El repo en GitHub debe contenerlo (usa Git LFS o un mirror privado;
> con repo público de >100 MB GitHub se queja — LFS resuelve).

---

## 3. Cloudflare — R2 (assets) + Workers (frontend)

### 3a. R2: los 271 MB de archivos del juego

```bash
bun run deploy:r2                      # sube game-files/ → r2://cs16-assets/assets/…
```

Luego en el dashboard de Cloudflare → **R2 → cs16-assets → Settings**:

1. **Public access**: activa el endpoint `r2.dev` (solo para pruebas) o mejor
   conecta un **dominio custom** (p. ej. `assets.tudominio.com`) — recomendado
   para producción.
2. **CORS policy** (Settings → CORS policy):

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range", "if-none-match"],
    "MaxAgeSeconds": 86400
  }
]
```

3. Anota la URL pública → será `NEXT_PUBLIC_ASSETS_BASE_URL`.

### 3b. Workers: el frontend con OpenNext

Crea `.env` (o configura las variables en el dashboard al desplegar):

```bash
NEXT_PUBLIC_CS16_BRIDGE_URL=wss://cs16-hlds-bridge.onrender.com
NEXT_PUBLIC_ASSETS_BASE_URL=https://assets.tudominio.com
TURSO_DATABASE_URL=libsql://cs16-tuusuario.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

Despliega:

```bash
bun run deploy:cf      # opennextjs-cloudflare build && deploy (usa wrangler.jsonc)
```

> Las variables `NEXT_PUBLIC_*` se **inlinean en build time**: si las cambias,
> redespliega. `TURSO_*` son runtime — también puedes setearlas con
> `bunx wrangler secret put TURSO_AUTH_TOKEN` etc.

Verifica: abre la URL del Worker (`https://cs16-web.<tu-subdomain>.workers.dev`),
el menú debe mostrar el estado del servidor en verde (viene de
`NEXT_PUBLIC_CS16_BRIDGE_URL/health` con CORS ya habilitado en el puente).

**Dominio propio**: en Cloudflare → Workers → cs16-web → Settings → Domains →
*Add custom domain* si quieres `jugar.tudominio.com`.

---

## 4. cron-job.org — que Render free no se duerma

Render free **duerme el servicio tras 15 min sin tráfico HTTP**. El primer
jugador tras el sleep esperaría 1-2 min (boot del contenedor + HLDS + bots).
Solución gratis: un cron que le pegue a `/health` cada 10 minutos.

1. Entra en [cron-job.org](https://cron-job.org) → *Cronjobs → Create cronjob*.
2. Configura:
   - **Title**: `CS16 keepalive`
   - **URL**: `https://cs16-hlds-bridge.onrender.com/health`
   - **Schedule**: Every 10 minutes
   - **Advanced**: Request method `GET`, guarda el Response si quieres vigilar
     que `hlds:true`.
3. Actívalo y listo.

Notas importantes:

- Mientras alguien **juega**, la conexión WebSocket ya mantiene el servicio
  despierto; el cron cubre los periodos sin jugadores.
- El plan free de Render incluye **750 h/mes de instancia**: un servicio
  siempre encendido consume ~744 h → **solo cabe un servicio free siempre
  despierto**. Con el cron a 10 min + un solo servicio, estás dentro del
  límite.
- Si quieres cero dependencia del cron y arranque instantáneo: Render
  **Starter ($7/mes)**.
- El cron NO evita el reinicio del HLDS si Render reprograma el contenedor
  (deploy/crash): el puente lo resucita solo (supervisor integrado), pero los
  marcadores de los bots se reinician — igual que en el sandbox.

---

## 5. Flujo final y verificación

```bash
# 1. Render vivo
curl https://cs16-hlds-bridge.onrender.com/health

# 2. Assets servidos por R2 con CORS y Range
curl -sI https://assets.tudominio.com/assets/engine/xash.wasm \
  -H "Origin: https://cs16-web.workers.dev" | grep -i "access-control\|content-type"
curl -sI https://assets.tudominio.com/assets/engine/xash.wasm \
  -H "Range: bytes=0-99" | grep -i "content-range"      # debe contestar 206

# 3. Frontend
#    abre https://cs16-web.<subdomain>.workers.dev → Jugar →
#    la barra debe llegar a 100% (descarga desde R2) y conectar al túnel WSS.
```

---

## 6. Troubleshooting

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| El menú queda en "servidor desconectado" | `NEXT_PUBLIC_CS16_BRIDGE_URL` mal escrito o Render dormido | Verifica la URL en la consola del navegador (`/health` 404/net::ERR); despierta Render o revisa el deploy |
| Descarga de assets al 0% con error CORS | Falta la CORS policy en el bucket R2 | Aplica el JSON del §3a y reintenta (Ctrl+F5) |
| Descarga se corta y no reanuda | R2 sin soporte Range (raro) o proxy intermedio | Verifica el 206 del §5.2 |
| WSS no conecta, consola: "Mixed Content" | Frontend en HTTPS hablando `ws://` | Usa `wss://` en `NEXT_PUBLIC_CS16_BRIDGE_URL` |
| `/health` responde `hlds:false` permanente | HLDS no arranca en el contenedor | `curl …/logs` y los Logs de Render; revisa que `QEMU` esté vacío y `HLDS_DIR` correcto |
| "Setting up renderer…" en bucle | El túnel WS no transporta UDP (puente caído o URL incorrecta) | Mira `/logs` del puente; verifica `packetsIn` creciendo en `/health` |
| Turso: "no such table" | Esquema no aplicado | Repite el `prisma migrate diff | turso db shell` del §1 |
| Render build falla por tamaño/lentitud | Contexto de build gigante | Mantén `.dockerignore` (excluye todo menos `hlds-ns-root` y `mini-services`) |
| Workers: error 1101 al abrir | Falta `nodejs_compat` o binding de assets | Verifica `wrangler.jsonc` (§3b) |

---

## 7. Qué se adaptó en el código para este despliegue

- `mini-services/cs16-server/index.ts` — paths y modo de ejecución por env vars
  (`HLDS_DIR`, `QEMU`, `SYSROOT`, `HLDS_PORT`, `HLDS_LOG_FILE`, `HLDS_MAP`,
  `HLDS_MAXPLAYERS`), auto-detección qemu (ARM) vs nativo (x86_64), y CORS en
  `/health` + `/logs`.
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
- `scripts/upload_r2.sh` — subida de los 271 MB a R2 bajo `assets/`.
