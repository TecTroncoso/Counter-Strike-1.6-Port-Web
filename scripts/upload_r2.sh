#!/usr/bin/env bash
# =============================================================================
# Sube game-files/ (271 MB) a un bucket público de Cloudflare R2.
#
# Estructura: el frontend pide  <NEXT_PUBLIC_ASSETS_BASE_URL>/assets/<ruta>,
# así que el contenido de game-files/ se sube bajo el prefijo "assets/":
#   game-files/engine/xash.wasm          →  r2://cs16-assets/assets/engine/xash.wasm
#   game-files/valve-parts/…             →  r2://cs16-assets/assets/valve-parts/…
#
# Requisitos:
#   bunx wrangler login          (una vez)
#   Bun install                  (el script usa wrangler vía bunx)
#
# Uso:
#   BUCKET=cs16-assets bash scripts/upload_r2.sh
#
# Después:
#   1. Publica el bucket (R2 → cs16-assets → Settings → Public access:
#      "Allow access" para el endpoint r2.dev, o conecta un dominio custom).
#   2. Configura CORS en el bucket (dashboard → Settings → CORS policy):
#      [ { "AllowedOrigins": ["*"],
#          "AllowedMethods": ["GET", "HEAD"],
#          "AllowedHeaders": ["range", "if-none-match"],
#          "MaxAgeSeconds": 86400 } ]
#   3. Pon NEXT_PUBLIC_ASSETS_BASE_URL=<url-pública-del-bucket> en el frontend.
# =============================================================================
set -euo pipefail

BUCKET="${BUCKET:-cs16-assets}"
SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/game-files"

command -v bunx >/dev/null 2>&1 || { echo "ERROR: instala bun primero (https://bun.sh)"; exit 1; }
[ -d "$SRC_ROOT" ] || { echo "ERROR: no existe $SRC_ROOT"; exit 1; }

echo "=== R2: subiendo $SRC_ROOT → r2://$BUCKET/assets/ ==="

# Crea el bucket si no existe (ignora el error si ya existe).
bunx wrangler r2 bucket create "$BUCKET" 2>/dev/null || true

count=0
total=$(find "$SRC_ROOT" -type f | wc -l)
while IFS= read -r file; do
  rel="${file#"$SRC_ROOT"/}"
  key="assets/$rel"
  # MIME correcto para WASM (el resto lo detecta wrangler por extensión).
  ctype="application/octet-stream"
  case "$rel" in
    *.wasm) ctype="application/wasm" ;;
    *.json) ctype="application/json" ;;
    *.txt)  ctype="text/plain" ;;
  esac
  count=$((count + 1))
  printf "[%d/%d] %s\n" "$count" "$total" "$key"
  bunx wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$ctype" --remote
done < <(find "$SRC_ROOT" -type f | sort)

echo "=== OK: $total objetos subidos a r2://$BUCKET ==="
echo "Siguiente paso: publica el bucket y configura CORS (cabecera de este script)."
