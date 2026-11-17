#!/usr/bin/env bash
# Copied from agent-colony@7da77bb: scripts/start-server.sh
# Changes: English comments; TOWER_PORT and src/config.mjs for the port; no node_modules check;
# a process on the port is replaced only when its /api/health says "agent-tower", and then
# exactly the PID that health reports (not the first listener `ss` finds); XDG_RUNTIME_DIR export.
# Starts the Agent Tower daemon in the background and waits until it answers.
#
#   ./scripts/start-server.sh            # port from config (default 4188)
#   TOWER_PORT=4190 ./scripts/start-server.sh
#
# A second call is a restart, but only for an Agent Tower daemon: a process on the port is
# replaced only when GET /api/health there answers with "name":"agent-tower". Anything else
# is left alone. Stop with ./scripts/stop-server.sh (or `kill <PID>`).
#
# Why a script: `wsl.exe -e` shells have no Node on PATH, and a plain `&` dies with the shell,
# hence setsid.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node > /dev/null || { echo "Node not found. nvm install $(cat .nvmrc)"; exit 1; }

# A daemon started through wsl.exe may lack XDG_RUNTIME_DIR; Colony's hook files and VS Code's
# IPC sockets live there.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

PORT="${TOWER_PORT:-$(node -e 'import("./src/config.mjs").then(m=>m.loadConfig({root:process.cwd(),argv:[]})).then(c=>console.log(c.port))')}"

# The PID that /api/health on 127.0.0.1 reports, if the answer names agent-tower AND that PID
# really listens on the port. Empty otherwise.
tower_pid() {
  local health pid
  health="$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" 2> /dev/null || true)"
  case "$health" in *'"name":"agent-tower"'*) ;; *) return 0 ;; esac
  pid="$(printf '%s' "$health" | grep -o '"pid":[0-9]*' | head -1 | cut -d: -f2 || true)"
  [ -n "$pid" ] || return 0
  ss -ltnpH "sport = :$PORT" 2> /dev/null | grep -q "pid=$pid[,)]" && echo "$pid"
  return 0
}

listener_pid() {
  ss -ltnpH "sport = :$PORT" 2> /dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true
}

OLD_PID="$(tower_pid)"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2> /dev/null || true
  for _ in $(seq 20); do
    kill -0 "$OLD_PID" 2> /dev/null || break
    sleep 0.25
  done
elif [ -n "$(listener_pid)" ]; then
  echo "Port $PORT is taken by PID $(listener_pid), which is not an Agent Tower daemon. Nothing stopped."
  echo "Other port: TOWER_PORT=4190 $0"
  exit 1
fi

LOG="${TMPDIR:-/tmp}/agent-tower.log"
# Absolute path in the command line, so no pattern-based kill from another script matches it.
TOWER_PORT="$PORT" setsid nohup node "$PWD/src/server.mjs" > "$LOG" 2>&1 < /dev/null &
disown

for _ in $(seq 20); do
  PID="$(tower_pid)"
  if [ -n "$PID" ]; then
    echo "Agent Tower -> http://127.0.0.1:$PORT   (PID ${PID:-?}, Log: $LOG)"
    grep "^Warning:" "$LOG" || true
    exit 0
  fi
  sleep 0.3
done

echo "Daemon does not answer. Log:"
cat "$LOG"
exit 1
