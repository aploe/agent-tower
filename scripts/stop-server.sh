#!/usr/bin/env bash
# Copied from agent-colony@7da77bb: scripts/stop-server.sh
# Changes: English comments; TOWER_PORT and src/config.mjs for the port; the daemon is
# recognised by its /api/health ("agent-tower") and stopped by the PID that health reports.
# Stops the Agent Tower daemon on the configured port (default 4188).
#
#   ./scripts/stop-server.sh
#   TOWER_PORT=4190 ./scripts/stop-server.sh
#
# Found by port, never by command-line pattern or process name. Only a process whose
# GET /api/health answers with "name":"agent-tower" is stopped; anything else is left alone.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node > /dev/null || { echo "Node nicht gefunden. nvm install $(cat .nvmrc)"; exit 1; }

PORT="${TOWER_PORT:-$(node -e 'import("./src/config.mjs").then(m=>m.loadConfig({root:process.cwd(),argv:[]})).then(c=>console.log(c.port))')}"

HEALTH="$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" 2> /dev/null || true)"
LISTENER="$(ss -ltnpH "sport = :$PORT" 2> /dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
if [ -z "$HEALTH" ] && [ -z "$LISTENER" ]; then
  echo "Auf Port $PORT läuft kein Server."
  exit 0
fi

PID=""
case "$HEALTH" in
  *'"name":"agent-tower"'*)
    PID="$(printf '%s' "$HEALTH" | grep -o '"pid":[0-9]*' | head -1 | cut -d: -f2 || true)"
    # Only the PID health reports, and only if it really listens on the port.
    ss -ltnpH "sport = :$PORT" 2> /dev/null | grep -q "pid=$PID[,)]" || PID=""
    ;;
esac
if [ -z "$PID" ]; then
  echo "Auf Port $PORT lauscht ${LISTENER:+PID $LISTENER, aber das ist }kein Agent-Tower-Daemon. Nichts beendet."
  exit 1
fi

kill "$PID" 2> /dev/null || true
for _ in $(seq 20); do
  if ! kill -0 "$PID" 2> /dev/null; then
    echo "Agent Tower auf Port $PORT beendet (PID $PID)."
    exit 0
  fi
  sleep 0.25
done
kill -9 "$PID" 2> /dev/null || true
sleep 0.25
if kill -0 "$PID" 2> /dev/null; then
  echo "PID $PID läuft noch, auch nach kill -9."
  exit 1
fi
echo "Agent Tower auf Port $PORT hart beendet (PID $PID)."
