// The collector: one snapshot per poll (spec 7.3). Wires the pure modules together.
// CLI: node src/collect.mjs --print | --explain <session-id-prefix>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { loadRegistry } from './sources/registry.mjs';
import { loadColonyHook } from './sources/colonyHook.mjs';
import { analyzeTranscript, locateTranscript, subagentOpenCalls } from './sources/transcript.mjs';
import { decideSessionState, wantsSubagents } from './state.mjs';
import { stepLabel, askSummary, planSummary, questionsOf, buildSteps } from './steps.mjs';
import { loadSettings } from './settings.mjs';
import { loadDismissed, updateDismissed, reconcile } from './dismissed.mjs';
import { DESKTOP_ID, windowsStartTimes } from './windows.mjs';
import { loadUnread as readUnread } from './sources/vscodeUnread.mjs';

const STATE_ORDER = { prompt: 0, waiting: 1, working: 2, idle: 3 };

/** Last path segment; Windows paths (`C:\Users\sam\notes`) split on the backslash. */
export function projectOf(cwd) {
  return String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Where a click on the row leads (spec §11, F30, F32). */
export function opensInOf(entry) {
  if (entry.entrypoint === 'claude-vscode') return 'vscode';
  if (entry.origin === 'windows' && entry.entrypoint === 'claude-desktop' && DESKTOP_ID.test(entry.hostSessionId ?? '')) {
    return 'desktop';
  }
  return null;
}

/** The claude folder an entry came from: its transcripts live there too. */
function claudeDirOf(cfg, entry) {
  return entry.origin === 'windows' ? cfg.windowsClaudeDir : cfg.claudeDir;
}

/** Both registries. `wsl`/`windows` are null when unreadable; `windows` is undefined when not
 *  configured. Windows trouble never touches the WSL result. */
async function loadRegistries(cfg, { procRoot, winStartTimes }) {
  const wsl = await loadRegistry(cfg, { procRoot });
  if (!cfg.windowsClaudeDir) return { wsl, windows: undefined };
  let windows;
  try {
    windows = await loadRegistry(cfg, { claudeDir: cfg.windowsClaudeDir, origin: 'windows', startTimes: winStartTimes });
  } catch {
    windows = null;
  }
  return { wsl, windows };
}

const liveEntries = (regs) => [...(regs.wsl?.live.values() ?? []), ...(regs.windows?.live.values() ?? [])];

export function titleOf({ name, nameSource, aiTitle, cwd }) {
  if (name && (nameSource === 'user' || nameSource === 'auto')) return name;
  return aiTitle || name || projectOf(cwd);
}

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOf = (s) => (s ? Date.parse(s) : null);

/** prompt: oldest stateSince first; the other groups: newest first; null times last; ties by id. */
export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const g = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
    if (g !== 0) return g;
    const ta = msOf(a.stateSince);
    const tb = msOf(b.stateSince);
    if (ta === null && tb !== null) return 1;
    if (tb === null && ta !== null) return -1;
    if (ta !== tb) return a.state === 'prompt' ? ta - tb : tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Everything the decision needs for one live session. A transcript problem never throws. */
async function gather(cfg, entry, hookMap, now) {
  const hook = hookMap?.get(entry.sessionId) ?? null;
  let info = { lastMs: null, lastType: null, aiTitle: null, calls: [], open: [] };
  let file = null;
  try {
    file = await locateTranscript(claudeDirOf(cfg, entry), entry.sessionId);
    if (file) info = await analyzeTranscript(file, { minToolCalls: 0 });
  } catch {
    file = null;
    info = { lastMs: null, lastType: null, aiTitle: null, calls: [], open: [] };
  }
  let subOpen = [];
  if (file && wantsSubagents({ registry: { status: entry.status }, hook, open: info.open })) {
    try {
      subOpen = await subagentOpenCalls(file, entry.sessionId, hook?.sinceMs ?? null);
    } catch {
      subOpen = [];
    }
  }
  const decision = decideSessionState({
    now, registry: entry, hook, open: info.open, subOpen, lastMs: info.lastMs, lastType: info.lastType, cfg,
  });
  return { hook, info, subOpen, decision };
}

function askOf(ask) {
  if (!ask) return null;
  const call = ask.call ?? null;
  const input = call?.input;
  // What is asked beats the registry's generic waitingFor ("permission prompt").
  let summary = null;
  if (call && ask.kind === 'question') summary = questionsOf(input)?.[0]?.question ?? null;
  else if (call) summary = ask.kind === 'plan' ? planSummary(input) : askSummary(call.name, input);
  if (summary == null) summary = ask.summary ?? null;
  return {
    kind: ask.kind,
    certain: ask.certain,
    via: ask.via,
    tool: call?.name ?? null,
    summary,
    questions: ask.kind === 'question' && call ? questionsOf(input) : null,
  };
}

function currentOf(info) {
  const c = info.open.at(-1);
  if (!c) return null;
  return { tool: c.name, label: stepLabel(c.name, c.input), since: iso(c.atMs) };
}

export async function collect(cfg, { now = Date.now(), procRoot = '/proc', winStartTimes = windowsStartTimes, loadUnread = readUnread } = {}) {
  const regs = await loadRegistries(cfg, { procRoot, winStartTimes });
  const hookMap = await loadColonyHook(cfg);
  // VS Code's unread marks (F34): a Set of session ids, null when not known.
  const unreadKeys = cfg.vscodeStateDb ? await loadUnread(cfg.vscodeStateDb) : null;
  const sources = {
    registry: regs.wsl !== null,
    colonyHook: hookMap !== null,
    windows: regs.windows === undefined ? null : regs.windows !== null,
    vscodeUnread: cfg.vscodeStateDb ? unreadKeys !== null : null,
  };
  const counts = { total: 0, prompt: 0, working: 0, waiting: 0, idle: 0, dismissed: 0 };
  const base = { generatedAt: iso(now), sources };
  if (!regs.wsl && !regs.windows) return { ...base, counts, sessions: [] };

  const sessions = await Promise.all(liveEntries(regs).map(async (e) => {
    const { info, decision: d } = await gather(cfg, e, hookMap, now);
    const opensIn = opensInOf(e);
    return {
      id: e.sessionId,
      pid: e.pid,
      cwd: e.cwd,
      project: projectOf(e.cwd),
      title: titleOf({ name: e.name, nameSource: e.nameSource, aiTitle: info.aiTitle, cwd: e.cwd }),
      entrypoint: e.entrypoint,
      startedAt: e.startedAt,
      state: d.state,
      stateSince: iso(d.stateSinceMs),
      stateSource: d.stateSource,
      // What the registry itself says (waiting, busy, …; null when it has no status). "waiting"
      // means a dialog is open in the session; `state` can be "prompt" without one, from an
      // open question in the transcript of a run that shows no dialog.
      registryStatus: typeof e.status === 'string' ? e.status : null,
      ask: d.state === 'prompt' ? askOf(d.ask) : null,
      current: currentOf(info),
      host: e.origin,
      opensIn,
      hostSessionId: opensIn === 'desktop' ? e.hostSessionId : null,
      canOpen: opensIn !== null,
      // Only VS Code marks sessions as read or unread; for the rest it is not known.
      unread: opensIn === 'vscode' && unreadKeys ? unreadKeys.has(e.sessionId) : null,
      dismissed: false,
    };
  }));

  // Hidden rows are a convenience: a failed save must not fail the snapshot. The next poll
  // retries it.
  // A side that could not be read says nothing about its sessions: keep their hidden rows.
  const keepAbsent = regs.wsl === null || regs.windows === null;
  let kept;
  try {
    kept = await updateDismissed(cfg, (entries) => reconcile(entries, sessions, { keepAbsent }));
  } catch (err) {
    console.error(`hidden rows could not be saved: ${err.message}`);
    kept = reconcile(await loadDismissed(cfg), sessions, { keepAbsent });
  }
  const hidden = new Set(kept.map((k) => k.sessionId));
  for (const s of sessions) {
    s.dismissed = hidden.has(s.id);
    counts.total++;
    counts[s.state]++;
    if (s.dismissed) counts.dismissed++;
  }
  return { ...base, counts, sessions: sortSessions(sessions) };
}

export async function explain(cfg, idPrefix, { now = Date.now(), procRoot = '/proc', winStartTimes = windowsStartTimes } = {}) {
  const regs = await loadRegistries(cfg, { procRoot, winStartTimes });
  const entry = liveEntries(regs).find((e) => e.sessionId.startsWith(idPrefix));
  if (!entry) return null;
  const hookMap = await loadColonyHook(cfg);
  const { hook, info, subOpen, decision } = await gather(cfg, entry, hookMap, now);
  return { registry: entry, hook, open: info.open, subOpen, lastMs: info.lastMs, lastType: info.lastType, decision };
}

export async function stepsFor(cfg, sessionId) {
  try {
    let file = null;
    for (const dir of [cfg.claudeDir, cfg.windowsClaudeDir].filter(Boolean)) {
      file = await locateTranscript(dir, sessionId);
      if (file) break;
    }
    if (!file) return { steps: [], terminal: null };
    const info = await analyzeTranscript(file, { minToolCalls: 15 });
    return buildSteps(info.calls);
  } catch {
    return { steps: [], terminal: null };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let cfg = await loadConfig({ root, argv: [] });
  cfg = { ...cfg, ...(await loadSettings(cfg)) }; // the user's overrides count here too, or the tool disagrees with the widget
  const args = process.argv.slice(2);
  if (args[0] === '--print') {
    console.log(JSON.stringify(await collect(cfg), null, 2));
  } else if (args[0] === '--explain' && args[1]) {
    const out = await explain(cfg, args[1]);
    console.log(out === null ? `no live session with id prefix ${args[1]}` : JSON.stringify(out, null, 2));
    if (out === null) process.exitCode = 1;
  } else {
    console.error('usage: node src/collect.mjs --print | --explain <id-prefix>');
    process.exitCode = 2;
  }
}
