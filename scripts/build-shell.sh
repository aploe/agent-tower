#!/usr/bin/env bash
# Builds the Windows shell from WSL and publishes it to %LOCALAPPDATA%\AgentTower\app\
# (Release, framework-dependent), writes settings.json there if none exists and puts
# "Agent Tower" into the Start Menu. Prints the Windows path of AgentTower.exe.
#
# Usage: scripts/build-shell.sh [--test]     --test runs the shell's unit tests first
#
# The sources stay where they are: dotnet.exe builds them over \\wsl.localhost\… (probe P2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOTNET="/mnt/c/Program Files/dotnet/dotnet.exe"
[ -x "$DOTNET" ] || { echo "dotnet.exe nicht gefunden: $DOTNET" >&2; exit 1; }

# cmd.exe cannot start in a \\wsl.localhost folder, so it is run from C:\.
win_env() { (cd /mnt/c && cmd.exe /c "echo %$1%" 2>/dev/null | tr -d '\r\n'); }
LOCALAPPDATA_WIN="$(win_env LOCALAPPDATA)"
APPDATA_WIN="$(win_env APPDATA)"
[ -n "$LOCALAPPDATA_WIN" ] && [ -n "$APPDATA_WIN" ] || { echo "%LOCALAPPDATA% oder %APPDATA% nicht lesbar" >&2; exit 1; }
DATA_WIN="${LOCALAPPDATA_WIN}\\AgentTower"
APP_WIN="${DATA_WIN}\\app"
EXE_WIN="${APP_WIN}\\AgentTower.exe"

if [ "${1:-}" = "--test" ]; then
  "$DOTNET" test "$(wslpath -w "$ROOT/shell.Tests/shell.Tests.csproj")" -nologo
fi

# A running app keeps its files open; publishing over them fails after ten retries.
if (cd /mnt/c && tasklist.exe /FI "IMAGENAME eq AgentTower.exe" /NH 2>/dev/null | grep -qi "AgentTower.exe"); then
  echo "Agent Tower läuft noch. Erst beenden (Tray-Symbol, Beenden), dann erneut bauen." >&2
  exit 1
fi

"$DOTNET" publish "$(wslpath -w "$ROOT/shell/AgentTower.csproj")" -c Release --self-contained false -o "$APP_WIN" -nologo

# Settings: only when there are none. An existing file is the user's.
SETTINGS_WSL="$(wslpath -u "${DATA_WIN}\\settings.json")"
if [ ! -e "$SETTINGS_WSL" ]; then
  printf '{\n  "distro": "%s",\n  "repoPath": "%s",\n  "port": %s\n}\n' \
    "${WSL_DISTRO_NAME:-Ubuntu}" "$ROOT" "${TOWER_PORT:-4188}" > "$SETTINGS_WSL"
fi

# Start Menu entry (created or pointed at the new exe).
ps_quote() { printf "%s" "${1//\'/\'\'}"; }
LNK_WIN="${APPDATA_WIN}\\Microsoft\\Windows\\Start Menu\\Programs\\Agent Tower.lnk"
(cd /mnt/c && powershell.exe -NoProfile -Command "\$s = (New-Object -ComObject WScript.Shell).CreateShortcut('$(ps_quote "$LNK_WIN")'); \$s.TargetPath = '$(ps_quote "$EXE_WIN")'; \$s.WorkingDirectory = '$(ps_quote "$APP_WIN")'; \$s.IconLocation = '$(ps_quote "$EXE_WIN"),0'; \$s.Description = 'Agent Tower'; \$s.Save()")

echo "$EXE_WIN"
