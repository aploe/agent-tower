# Agent Tower — project instructions

A small always-on-top Windows window that lists the live Claude Code sessions in WSL, shows which ones need André, and jumps to their VS Code tab. With its hook installed it also answers their permission prompts and questions. Sober sibling of `~/personal-projects/agent-colony` (the playful map), built as a separate project.

- Design: `docs/superpowers/specs/2026-11-16-agent-tower-design.md`. Read it before changing behaviour; it records what André decided and what Claude decided for him (section 14).
- Plan: `docs/superpowers/plans/2026-11-16-agent-tower-stage-1.md`. Tasks are worked off in order; tick the checkboxes as you go.
- Answering from the widget (stage 2): design `docs/superpowers/specs/2026-11-17-agent-tower-stage-2-design.md`, plan `docs/superpowers/plans/2026-11-17-agent-tower-stage-2.md`. Read the design before touching `src/requests.mjs`, the hook or answer routes in `src/app.mjs`, the request blocks of the page, or `scripts/answer-hook.mjs`; its facts table (F35 and up) says what was measured about Claude Code's hook and what was not.
- `docs/superpowers/` (specs and plans) is local only: gitignored and not in the public repo since 2026-11-17. Read, write and tick there as before, but never commit it.
- Visual reference: `scratchpad/reel/` (stills of the reel "Agent Huddle"). The look is the target, the mascot is not copied.
- The parent folder's `~/personal-projects/CLAUDE.md` applies too: answer André in German, prefer simple solutions.

## Three parts

| Part | Where | Runs on |
|------|-------|---------|
| Daemon | `src/`, `scripts/` | WSL, Node standard library only |
| Widget page | `public/` | served by the daemon, shown in the shell (and in any browser for checks) |
| Shell | `shell/` | Windows, .NET (WPF) hosting WebView2 |

## Not negotiable

- **The running sessions are touched in one way only: the answer hook.** The daemon never writes under `~/.claude/`. It writes only inside its own state folder `${XDG_STATE_HOME:-~/.local/state}/agent-tower/`: the hidden-rows file and the user's settings (relaxed by André on 2026-11-17). Nothing under `/mnt/c` is written either; the Windows `.claude` folder is read only.
- **`~/.claude/settings.json` is written by `scripts/answer-hook.mjs` and by nothing else here**, and against the real file only when André says so in that moment. It adds or removes one entry under `hooks.PermissionRequest`. Tests and trial runs name a made-up file with `--file` and their own `XDG_STATE_HOME`.
- **The daemon never decides a permission request by itself.** It answers a hook call only if it holds that request, and only as the direct result of a click that names it: no rules, no remembering, no default, no decision on timeout. Everything it does not hold, and every internal error, gets "no decision" at once (status 200, empty body), so that the session carries on as it does without the hook. Nothing of a request (command, path, question) is logged or written to disk.
- **Nothing here ends a session or a process that it did not start itself.** "Cross off" hides a row.
- **Unknown is shown as unknown.** No guessed value presented as fact; an unproven prompt reads "probably asking".
- **Agent Colony is a read-only source.** Code is copied from its commit `7da77bb` with a header line naming the origin. Do not edit anything in that repo from here.
- **No runtime dependencies in the daemon, no build step for the page.** A new package needs a reason in the commit message.
- **Everything listens on `127.0.0.1` only.**
- **Text from sessions (titles, commands, questions) goes into the page as text, never as HTML.**

## How to work

- **Daemon and data (`src/`)**: test first with `node --test`, then check against real data. Every data bug in Agent Colony came from real data, not from fixtures. `node scripts/check-live.mjs` compares the daemon's session list with `claude agents --json`, the WSL rows with the WSL CLI and the Windows rows with `claude.exe` (Windows sessions: design §11); Windows is reached only through `powershell.exe` and `wslview`, from `src/windows.mjs` and `src/vscode.mjs`; `node src/collect.mjs --explain <session-id-prefix>` shows why a row has its state.
- **UI text** exists in English (default) and German: the page in `public/strings.mjs`, the daemon's refusals a row can show in `src/messages.mjs`, the shell's tray and own pages in `shell/Logic/ShellText.cs`. A new text goes into both languages; tests check that the tables match. `node scripts/shot.mjs … --fixture <name> --lang de` shows the German page.
- **Page (`public/`)**: edit, take a screenshot with `node scripts/shot.mjs`, look at the image, commit. A screenshot nobody looked at is not a check. Work in the main session; no subagent and no review per change.
- **Shell (`shell/`)**: pure logic is unit-tested (`shell.Tests`); window behaviour is checked by starting the app and looking.
- Flag over-engineering, in code and in process. This is a tool for one person; a mistake costs nothing and is fixed in the next step.
- When a check needs André (an open permission dialog, a look at the mock, the acceptance walk), stop and ask instead of guessing.

## Environment

- Node: `~/.nvm/versions/node/v24.19.0/bin` (also v20.17.0). Non-interactive shells (`wsl.exe -e …`, cron) have no Node on `PATH`; scripts set it from `.nvmrc`.
- .NET runs on Windows: `"/mnt/c/Program Files/dotnet/dotnet.exe"` (SDK 10). Windows paths for it come from `wslpath -w`.
- Windows reaches the daemon through `http://127.0.0.1:<port>` (default 4188). WSL networking is NAT; the other direction does not work.
- VS Code's remote CLI needs `VSCODE_IPC_HOOK_CLI`; the daemon picks a live socket itself (design, section 7.9).
- Playwright is installed globally under nvm, not in `package.json`; `scripts/shot.mjs` resolves it from there.
- **Server ownership:** whoever tests starts their own daemon (`node src/server.mjs --port 0`) and stops only that PID. Never `pkill`, never stop a process by name. The daemon on the configured port usually has André's widget attached, and with the answer hook installed every session's permission requests go to it: restarting it is André's step (tray menu "Restart daemon"), or needs his go in that moment. A test that needs hook calls points a project-scoped hook (`.claude/settings.local.json` in a folder under `scratchpad/`) at its own daemon.
- **Restarting André's widget is allowed** (André, 2026-11-17), e.g. so it loads a changed page; the page cannot be reloaded from outside. Closing the window only hides it, so: look up the PID of `AgentTower.exe` (`Get-CimInstance Win32_Process -Filter "Name='AgentTower.exe'"`), end exactly that tree with `taskkill.exe /F /T /PID <pid>` (its only children are WebView2 processes; the daemon in WSL keeps running), then `Start-Process` `%LOCALAPPDATA%\AgentTower\app\AgentTower.exe` with that folder as working directory. Run Windows tools from `/mnt/c`. Say so afterwards.
- Working files (screenshots, probe output, drafts) go to `scratchpad/<topic>/`, never to committed paths.
- In Bash tool calls avoid `$(...)`, backticks and shell variables; they always trigger a permission prompt. Scripts in files may use them.
- This repo sits inside the Git repo `~/personal-projects` and is ignored there. Never `git add .` in the parent.

## Git

- Commit on your own in small, topical steps: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, English subject and body, the body says why.
- `git commit -m "subject" -m "body"`; no heredocs.
- The repo is public: `origin` is `https://github.com/aploe/agent-tower`, licence PolyForm Internal Use 1.0.0 (`LICENSE`). Push only when André says so.
- Because it is public, fixtures, tests, code comments and commit messages carry no real session titles, session ids, project folder names, user paths or other private data; sample data is made up.
- The history before the first public commit is kept locally under the tag `pre-public`. Never push that tag or anything based on it.
- Local `user.email` is the GitHub noreply address; keep it.
