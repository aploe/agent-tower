# Agent Tower

Agent Tower is a small Windows window that stays on top and lists the Claude Code sessions running in WSL. It shows which of them wait for an answer or a permission, and the arrow on a row brings that session's VS Code tab to the front. It only reads: it installs no hooks and never ends a session.

There are two programs. A daemon in WSL (`src/`, Node without packages) reads Claude Code's session registry and transcripts and serves the widget page from `public/` on `http://127.0.0.1:4188`. The Windows shell (`shell/`, WPF with WebView2) shows that page in a frameless window with a tray icon, and starts the daemon when it does not answer.

## Requirements

- WSL 2 with Node 22.13 or newer (the read marks taken from VS Code need the built-in `node:sqlite`; with an older Node they stay unknown). The scripts look for the nvm version named in `.nvmrc` first, then for `node` on the `PATH`.
- On Windows the .NET 10 SDK and the WebView2 runtime, which Windows 11 brings along.
- For the arrow: VS Code with the Claude Code extension, and `wslview` in WSL (package `wslu`).

## Install

Run this in WSL:

```
./scripts/build-shell.sh
```

It publishes the shell to `%LOCALAPPDATA%\AgentTower\app\`, writes `settings.json` one folder up if there is none yet, and puts "Agent Tower" into the Start Menu. With `--test` it runs the shell's unit tests first. The app has to be closed while it is rebuilt (tray icon, "Beenden"); the script says so when the exe is still in use.

Start the app from the Start Menu. It checks whether the daemon answers and starts it if not. The header's X hides the window, a left click on the tray icon brings it back. The gear in the header opens the settings: start with Windows, always on top, and after how long a finished session moves to the slim rows.

## The daemon by hand

```
./scripts/start-server.sh    # starts it; a second call restarts it
./scripts/stop-server.sh
```

The daemon writes its log to `/tmp/agent-tower.log`, and the page opens in any browser at `http://127.0.0.1:4188/`. Quitting the app leaves the daemon running. For another port set `"port"` in the shell's `settings.json`; the shell hands it to the start script. Started by hand, the script takes the port from `TOWER_PORT` or from the config file.

## Where things live

| What | Where |
|------|-------|
| Shell settings: `distro`, `repoPath`, `port`, `topmost` | `%LOCALAPPDATA%\AgentTower\settings.json` |
| Window position | `%LOCALAPPDATA%\AgentTower\window.json` |
| WebView2 profile | `%LOCALAPPDATA%\AgentTower\WebView2\` |
| Hidden rows | `~/.local/state/agent-tower/dismissed.json`, or under `$XDG_STATE_HOME` if that is set |
| Daemon config | `config/tower.config.json`, with overrides for this machine in `config/tower.local.json` |
| Daemon settings changed in the widget | `~/.local/state/agent-tower/settings.json`; they override both config files |

## Checks

`npm test` runs the daemon's and the page's unit tests. `node scripts/check-live.mjs` compares the daemon's session list with `claude agents --json`, and `node src/collect.mjs --explain <session-id-prefix>` prints why a row has its state. `node scripts/shot.mjs out.png` takes a screenshot of the page; `--fixture all-states` shows every kind of row without live sessions.

## Uninstall

Switch off "Mit Windows starten" in the widget's settings, or delete the value `AgentTower` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` by hand. Quit the app and run `./scripts/stop-server.sh`. Then delete the folder `%LOCALAPPDATA%\AgentTower`, the shortcut `Agent Tower.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\`, and `~/.local/state/agent-tower` in WSL.

## Credits

The look of the widget follows the "Agent Huddle" widget shown in an [Instagram reel by alextsoi_ai](https://www.instagram.com/reel/Dfphrw3griE/). Figures and code are not taken from it.

## Licence

PolyForm Internal Use License 1.0.0, see `LICENSE`: you may use and change Agent Tower, also inside your company, but you may not distribute it. Bundled fonts and the code taken over from Agent Colony are listed in `LICENSES.md`.
