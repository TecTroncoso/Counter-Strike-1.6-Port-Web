# Counter-Strike 1.6 — Web Port (Xash3D FWGS → WebAssembly)

Port **real** de Counter-Strike 1.6 al navegador: motor compatible con GoldSrc
(Xash3D FWGS) compilado a WebAssembly, lógica de juego open-source (cs16-client +
ReGameDLL-CS), bots YaPB y un servidor dedicado HLDS de verdad para multijugador
vía túnel WebSocket→UDP. Sin emuladores, sin remakes: el juego original corriendo
en un `<canvas>` con WebGL2.

## Contenido del paquete

| Carpeta / fichero | Qué es |
|---|---|
| `src/` | App Next.js 16 (App Router): UI, loader de assets (SHA-256 + unzip en streaming), arranque del motor, red virtual |
| `src/app/assets/[...path]/route.ts` | Servidor de assets en streaming con soporte HTTP Range (sirve `game-files/`) |
| `mini-services/cs16-server/` | Puente WebSocket↔UDP (Bun, puerto 3010) + health endpoint (`/health`) |
| `game-files/` | Binarios servidos al navegador: motor WASM (`xash.wasm`, `libref_webgl2`, `filesystem_stdio`), librerías WASM del juego (cs, client, menu, yapb), `extras.pk3` y `valve-parts/` (valve.zip troceado en 27 partes con `manifest.json` + SHA-256) |
| `scripts/` | Utilidades: análisis del contenido de Valve, troceado de assets, descarga/config del HLDS (`pull_hlds*.py`), test del descompresor, capturas de las pruebas E2E |
| `db/` + `prisma/` | SQLite vía Prisma (el esquema base del proyecto) |
| `Caddyfile` | Gateway de referencia: enruta `?XTransformPort=3010` al puente y el resto a Next (:3000) |
| `tests/`, `examples/` | Pruebas y ejemplos de WebSocket |

**No incluido** (se regenera o se descarga por separado):
`node_modules/`, `.next/`, el servidor HLDS (`hlds-ns-root/`, `compat/`, `steamcmd/`
— ~2.3 GB instalables con SteamCMD, ver abajo) y logs.

## Requisitos

- **Bun** ≥ 1.1 (alternativa: Node 20+ con npm/pnpm)
- Navegador con **WebGL2** (Chrome/Edge/Firefox recientes) — escritorio recomendado
- Para el servidor dedicado: Linux x86_64 con librerías 32-bit (`libc6-i386` en Debian/Ubuntu). En hosts ARM hace falta `qemu-user-i386` y un sysroot i386.

## Puesta en marcha

```bash
# 1) Dependencias del frontend
bun install

# 2) Base de datos SQLite (Prisma)
bun run db:push

# 3) Puente WebSocket↔UDP (terminal aparte)
cd mini-services/cs16-server && bun install && bun run dev
#    escucha en :3010 · health: /health

# 4) App Next.js (otro terminal)
bun run dev        # http://localhost:3000

# 5) Gateway (opcional en local, imprescindible como el original en producción)
caddy run --config Caddyfile   # escucha :81 y enruta por XTransformPort
```

Abre la app → escribe tu nick → **▶ JUGAR AHORA**. El mapa y la cantidad de bots
son configuración del servidor, no controles del navegador.
La primera carga descarga y verifica ~224 MB (queda cacheado por el navegador;
cada parte de 8 MB lleva SHA-256). Con assets servidos por Cloudflare Static
Assets, Cloudflare sirve el archivo completo; R2 puede habilitarse para
descargas parciales/resumibles mediante `NEXT_PUBLIC_ASSETS_BASE_URL`.

### Controles rápidos in-game

`5` elegir equipo (auto) · clic captura el ratón · `ESC` lo libera · `B` compra ·
`` ` `` consola · `Tab` marcador.

### Servidor dedicado HLDS + bots (multijugador)

1. En producción, despliega `deploy/render/Dockerfile` mediante el Blueprint de
   `deploy/render/render.yaml`; la imagen oficial incluye el HLDS, MetaMod-P,
   ReGameDLL y YaPB.
2. Para el sandbox legacy, `scripts/pull_hlds.py` extrae las capas de esa misma
   imagen oficial en las rutas absolutas del entorno sandbox. No es el instalador
   general de producción.
3. El puente (`mini-services/cs16-server`) mapea cada WebSocket de navegador a un
   socket UDP propio contra `127.0.0.1:27015` — cada pestaña/dispositivo es un
   jugador independiente.
4. El diagnóstico RCON local es opcional: configura el mismo
   `HLDS_RCON_PASSWORD` en el `server.cfg` local y en el entorno, y ejecuta
   `HLDS_RCON_PASSWORD='tu-secreto' python3 scripts/rcon.py "status"`.

Sin HLDS también funciona el arranque, pero el cliente quedará en el menú: el
multijugador requiere el servidor dedicado.

## Arquitectura (resumen)

```
Navegador                    Gateway (Caddy)              Sandbox / tu servidor
┌──────────────────────┐     ┌──────────────┐             ┌─────────────────────┐
│ Next.js 16 (UI)      │←────│  :81 / :443  │────────────→│ Next dev :3000      │
│ Xash3D FWGS (WASM)   │     └──────────────┘             │ bridge Bun :3010 ───┼──→ HLDS :27015
│ cs16-client (WASM)   │     ws://…/?XTransformPort=3010  │  (ws ⇄ udp)         │    (qemu-i386)
│ WebGL2 + Net virtual │                                  │                     │    + metamod + YaPB
└──────────────────────┘                                  └─────────────────────┘
```

- El motor usa un backend de red virtual (`src/lib/cs16/net.ts`): los datagramas
  UDP del protocolo HL (48) viajan por WebSocket y salen por UDP real en el bridge.
- `connect webxash3d.3000:27015` es el hostname virtual que resuelve el túnel.
- El join se detecta por caudal real de paquetes (`/health` del bridge), no por logs.

## Notas legales

Proyecto técnico basado en componentes open-source: Xash3D-FWGS (GPL), cs16-client,
ReGameDLL-CS y YaPB. Counter-Strike y Half-Life son marcas de Valve Corporation; los
assets del juego (`valve-parts/`) proceden de tu copia legítima de CS 1.6 y se sirven
solo desde tu propio servidor — no los redistribuyas.
