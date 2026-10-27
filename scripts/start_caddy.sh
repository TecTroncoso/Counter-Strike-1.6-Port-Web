#!/bin/bash
# Arranca Caddy :81 -> :3000 para el gateway de preview (Task 8/10)
if pgrep -f "caddy run" > /dev/null; then
  echo "caddy ya activo"
else
  cd /home/z/my-project
  setsid nohup /usr/bin/caddy run --config /home/z/my-project/Caddyfile > /home/z/my-project/caddy.log 2>&1 &
  echo "caddy lanzado (pid $!)"
fi
