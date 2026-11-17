# Agent Tower

A Claude Code session that waits for your answer does nothing until you look. Agent Tower keeps those sessions in view. It is a small window in the corner of your Windows desktop that lists every running session and puts the ones that need you on top. From there you answer a permission prompt or a question on the spot, or open the right VS Code tab with one click.

![Agent Tower: two sessions asking for you at the top of the list, one waiting for permission to push with Allow and Deny under the command, one with a question about a CSV export whose second option is picked; next to it the detail view of a session that runs a test suite](docs/img/hero.png)

*The screenshots show made-up demo sessions.*

## Why

Three sessions you can keep in your head. Twelve you can't. One is waiting for permission to push, another asked you a question twenty minutes ago, and two finished long ago without anyone reading what they wrote. Each of them has left a hint somewhere, on a tab in a VS Code window hidden behind the browser.

Meanwhile those agents sit idle, and the work they would do next waits for a single "yes". Agent Tower is about that gap: the minutes between Claude needing you and you knowing it.

## What it does

Sessions that wait for a permission, an answer or a plan approval get a lime frame and move to the top. The header counts them ("2 asking") and keeps counting when you fold the window down to that one line. A permission prompt raised by a subagent shows up on its parent's row, because that is where you answer it.

The card shows what the session wants: the full command it is about to run, or the question with its options. Allow and Deny sit right under the command; a question takes your pick and a click on Send. The dialog in VS Code stays open next to it, and whichever of the two you use first settles the request. This needs the answer hook, which you add once with a script (see "Answering from the widget" below). Without it the card shows the request and leaves the answer to VS Code.

Some requests need more than a yes or a no, and for those the arrow takes you to the session. For a session in VS Code it brings that window and tab to the front; a session in the Claude desktop app opens in the app. When the target is unclear, for example because no VS Code window shows the session's folder, the row says so instead of guessing.

A click on a row opens the session's last 30 steps and the last terminal command with its output. Hovering over a step's mark or icon says what it stands for. The coloured faces at the top switch between sessions.

![The rest of the list: working sessions with their current step, finished ones with a dot that stays lime while unread, older ones as slim lines; next to it the folded header and the settings, with the switch for answering in the widget](docs/img/rows.png)

Everything else stays quiet. A working session shows the step it is on. A finished one in VS Code shows a lime dot until you have read it there, then a grey one. After four hours a finished session shrinks to a single line; the settings offer 30 minutes up to 8 hours. The X hides a row until its state changes. The list updates every second.

## What it leaves alone

Without the answer hook Agent Tower only reads. It writes nothing into Claude Code's folders and has no button that ends a session or a process. Its state (hidden rows and your settings) lives in a folder of its own, and the daemon listens on `127.0.0.1` only. Quit it and nothing changes for your sessions; they never knew it was there.

The hook is the one exception, and you add it yourself: a script puts a single entry into Claude Code's settings and takes it out again. Even then the daemon decides nothing on its own. A request is allowed or denied by your click on that request, and by no rule, default or timeout. While the daemon is not running, sessions behave as they do without the hook. The log notes each answered request with its tool and outcome, never the command or the question.

It also does not pretend. A long-running command can look like a permission prompt, so when Agent Tower cannot prove that a session is asking, the row says "probably asking" behind a dashed frame instead of the lime one. A value it cannot know is shown as a dash, not as a plausible guess.

## Where it runs

Agent Tower is made for one setup: Windows 11 with Claude Code in WSL 2, used through the VS Code extension. Sessions of Claude Code on Windows itself, in VS Code or in the Claude desktop app, appear in the same list. Cloud sessions of the desktop app leave no trace on the machine and are missing. macOS and Linux desktops are not supported.

Answering in the widget works for sessions of the VS Code extension in WSL. Sessions on Windows, in the desktop app or in a terminal are listed and opened as described above, and answered where they run.

There are two programs. A daemon in WSL (`src/`, Node without packages) reads Claude Code's session registry and transcripts, holds the requests that come in through the hook, and serves the widget page from `public/` on `http://127.0.0.1:4188`. The Windows shell (`shell/`, WPF with WebView2) shows that page in a frameless window with a tray icon, and starts the daemon when it does not answer.

If you would rather have a map than a list, with the Git state of every repository and a 3D view, look at the playful sibling [Agent Colony](https://github.com/aploe/agent-colony). Agent Tower reuses its session logic and leaves out everything you would have to explore.

## Requirements

- WSL 2 with Node 22.13 or newer (the read marks taken from VS Code need the built-in `node:sqlite`; with an older Node they stay unknown). The scripts look for the nvm version named in `.nvmrc` first, then for `node` on the `PATH`.
- On Windows the .NET 10 SDK and the WebView2 runtime, which Windows 11 brings along.
- For the arrow: VS Code with the Claude Code extension, and `wslview` in WSL (package `wslu`).
- For answering in the widget: a Claude Code version whose hooks can be of type `http`. Tested with version 2.1.326 of the VS Code extension.

## Install

Run this in WSL:

```
./scripts/build-shell.sh
```

It publishes the shell to `%LOCALAPPDATA%\AgentTower\app\`, writes `settings.json` one folder up if there is none yet, and puts "Agent Tower" into the Start Menu. With `--test` it runs the shell's unit tests first. The app has to be closed while it is rebuilt (tray icon, "Quit"); the script says so when the exe is still in use.

Start the app from the Start Menu. It checks whether the daemon answers and starts it if not. The header's X hides the window, a left click on the tray icon brings it back. The gear in the header opens the settings: start with Windows, always on top, answering in the widget, after how long a finished session moves to the slim rows, and the language (English or German).

To answer in the widget, add the hook once:

```
node scripts/answer-hook.mjs install
```

The next section says what that changes and how to take it out again.

## Answering from the widget

Claude Code can hand each permission request to a hook before it asks you. Agent Tower's hook sends the request to the daemon, which holds it until you answer, in the widget or in VS Code.

`install` adds one entry under `hooks.PermissionRequest` in `~/.claude/settings.json` and leaves every other hook where it is. Before it writes, it copies the file to `~/.local/state/agent-tower/backups/`. `install --dry-run` prints the change without making it, `status` says whether the hook is in the file and whether the daemon answers, and `uninstall` takes the entry out again. Sessions that are already running use the hook from their next request on; nothing needs a restart.

A permission prompt comes with the whole command, or the file path for an edit, and the buttons Allow and Deny. Deny stops the session the way "No" does in VS Code. A question comes with its options, also when one call asks several questions or allows more than one choice. A request raised by a subagent says so above its block. Answer in VS Code instead, and the buttons in the widget disappear a few seconds later.

Some answers stay in VS Code: "always allow", a denial with a reason, a typed answer to a question, plan approvals, and anything you want to read as a diff first. A request whose text is longer than 4000 characters is not offered in the widget either, because it would have to be cut.

A stray click must not run a command, and the widget is built around that. The command is shown in full and scrolls inside its box when it is long. The buttons ignore clicks for half a second after they appeared or moved, so a click that was already on its way lands on nothing, and they are off while the daemon cannot be reached. Without your click a request waits. After twelve hours the hook gives up and the request is left to VS Code.

Nothing depends on the daemon being there. While it is stopped, Claude Code gets no answer from the hook and shows its dialog as usual. Runs without a dialog, such as `claude -p`, are handed back within a few seconds. For a break from the buttons, switch off "Answer in the widget" in the settings: every request then passes through, and the hook stays where it is.

The hook points at the daemon's port. After changing the port, run `install` again; it replaces the old entry. A daemon from before this feature answers the hook with an error that Claude Code ignores, so restart the daemon after an update (tray icon, "Restart daemon") to get the buttons.

## The daemon by hand

```
./scripts/start-server.sh    # starts it; a second call restarts it
./scripts/stop-server.sh
```

The daemon writes its log to `/tmp/agent-tower.log`, and the page opens in any browser at `http://127.0.0.1:4188/`. Quitting the app leaves the daemon running. For another port set `"port"` in the shell's `settings.json`; the shell hands it to the start script. Started by hand, the script takes the port from `TOWER_PORT` or from the config file.

## Where things live

| What | Where |
|------|-------|
| Shell settings: `distro`, `repoPath`, `port`, `topmost`, `language` | `%LOCALAPPDATA%\AgentTower\settings.json` |
| Window position | `%LOCALAPPDATA%\AgentTower\window.json` |
| WebView2 profile | `%LOCALAPPDATA%\AgentTower\WebView2\` |
| Hidden rows | `~/.local/state/agent-tower/dismissed.json`, or under `$XDG_STATE_HOME` if that is set |
| Daemon config | `config/tower.config.json`, with overrides for this machine in `config/tower.local.json` |
| Daemon settings changed in the widget | `~/.local/state/agent-tower/settings.json`; they override both config files |
| The answer hook | one entry under `hooks.PermissionRequest` in `~/.claude/settings.json`, written only by `scripts/answer-hook.mjs` |
| Copies of Claude Code's `settings.json`, one before each change by that script | `~/.local/state/agent-tower/backups/` |

## Checks

`npm test` runs the daemon's and the page's unit tests. `node scripts/check-live.mjs` compares the daemon's session list with `claude agents --json`, and `node src/collect.mjs --explain <session-id-prefix>` prints why a row has its state. `node scripts/answer-hook.mjs status` tells whether the hook is installed and the daemon answers. `node scripts/shot.mjs out.png` takes a screenshot of the page; `--fixture all-states` shows every kind of row without live sessions, and `--fixture demo` shows the made-up sessions from the screenshots above.

## Uninstall

If you installed the answer hook, take it out first with `node scripts/answer-hook.mjs uninstall`. Switch off "Start with Windows" in the widget's settings, or delete the value `AgentTower` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` by hand. Quit the app and run `./scripts/stop-server.sh`. Then delete the folder `%LOCALAPPDATA%\AgentTower`, the shortcut `Agent Tower.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\`, and `~/.local/state/agent-tower` in WSL (it holds the backups of Claude Code's settings too).

## Credits

The look of the widget follows the "Agent Huddle" widget shown in an [Instagram reel by alextsoi_ai](https://www.instagram.com/reel/Dfphrw3griE/). Figures and code are not taken from it.

## Licence

PolyForm Internal Use License 1.0.0, see `LICENSE`: you may use and change Agent Tower, also inside your company, but you may not distribute it. Bundled fonts and the code taken over from Agent Colony are listed in `LICENSES.md`.
