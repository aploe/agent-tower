// Pure session state decision, spec section 7.2, order changed by probe P1:
// the registry marks open permission prompts itself (status `waiting`) and flips back to
// `busy` on grant; the Colony hook only has the rising edge. So:
//   rule 1 (interactive tool) -> rule 4 (registry waiting/busy/shell/idle)
//   -> rules 2a/2b/2c/3 (hook + heuristics, ONLY when the registry status is absent/unknown)
//   -> rule 5 (Colony's decideState). First match wins; rule ids are unchanged.
import { decideState, INTERACTIVE_TOOLS, PROMPT_EDGE_TOLERANCE_MS } from './fallbackState.mjs';

export const LONG_RUNNING = new Set(['Agent', 'Monitor', 'Workflow', 'TaskOutput']);
export const INTERACTIVE = new Set(INTERACTIVE_TOOLS);

const MIN = 60000;

const isQualifying = (c) => c?.status === 'running' && !LONG_RUNNING.has(c.name);

/** Oldest call first; calls without a timestamp sort last. */
function oldest(calls) {
  let best = null;
  for (const c of calls) {
    if (best === null) best = c;
    else if (c.atMs != null && (best.atMs == null || c.atMs < best.atMs)) best = c;
  }
  return best;
}

const REGISTRY_KNOWN = new Set(['waiting', 'busy', 'shell', 'idle']);
const registryKnown = (registry) => REGISTRY_KNOWN.has(registry?.status);

export function wantsSubagents({ registry, hook, open }) {
  if ((open ?? []).some(isQualifying)) return false;
  if (registry?.status === 'waiting') return true;
  return !registryKnown(registry) && hook?.status === 'prompt';
}

const permission = (certain, via, call, summary = null) => ({ kind: 'permission', certain, via, call, summary });

/**
 * Rule 2a/2b/2c on one list of calls. `since` may be null (vouches for nothing).
 * Returns { call, certain } or null. Calls with atMs null cannot be compared.
 */
function judgeHookPrompt(calls, since, now, promptAfterMs) {
  const c = oldest(calls.filter((x) => x.atMs != null));
  if (!c) return null;
  if (since != null && c.atMs <= since + PROMPT_EDGE_TOLERANCE_MS) return { call: c, certain: true };
  if (now - c.atMs > promptAfterMs) return { call: c, certain: false };
  return null;
}

export function decideSessionState({ now, registry, hook, open, subOpen, lastMs, lastType, cfg }) {
  const openCalls = open ?? [];
  const promptAfterMs = cfg.promptAfterSeconds * 1000;
  const result = (state, stateSinceMs, stateSource, rule, ask = null) => ({ state, stateSinceMs, stateSource, rule, ask });

  // Rule 1: interactive tool still open.
  const interactive = oldest(openCalls.filter((c) => c.status === 'running' && INTERACTIVE.has(c.name)));
  if (interactive) {
    const kind = interactive.name === 'AskUserQuestion' ? 'question' : 'plan';
    return result('prompt', interactive.atMs ?? null, 'transcript', '1',
      { kind, certain: true, via: 'main', call: interactive, summary: null });
  }

  const qualifying = openCalls.filter(isQualifying);

  // Rule 4: registry status, whenever it is one of the known values.
  const status = registry?.status;
  const regSince = registry?.statusUpdatedAtMs ?? null;
  if (status === 'busy' || status === 'shell') return result('working', regSince, 'registry', '4');
  if (status === 'idle') {
    const stale = regSince != null && now - regSince >= cfg.idleAfterMinutes * MIN;
    return result(stale ? 'idle' : 'waiting', regSince, 'registry', '4');
  }
  if (status === 'waiting') {
    const wf = typeof registry.waitingFor === 'string' && registry.waitingFor !== '' ? registry.waitingFor : null;
    const mainCall = oldest(qualifying);
    const subCall = mainCall ? null : oldest((subOpen ?? []).filter(isQualifying));
    return result('prompt', regSince, 'registry', '4',
      permission(true, subCall ? 'subagent' : 'main', mainCall ?? subCall, wf));
  }

  if (!registryKnown(registry)) {
    // Rule 2 (only without a usable registry status): Colony hook says prompt.
    if (hook?.status === 'prompt') {
      const since = hook.sinceMs ?? null;
      if (qualifying.length > 0) {
        const j = judgeHookPrompt(qualifying, since, now, promptAfterMs);
        if (j) {
          return result('prompt', j.call.atMs, j.certain ? 'hook' : 'transcript', j.certain ? '2a' : '2b',
            permission(j.certain, 'main', j.call));
        }
      } else {
        const j = judgeHookPrompt((subOpen ?? []).filter(isQualifying), since, now, promptAfterMs);
        if (j) {
          return result('prompt', j.call.atMs, j.certain ? 'hook' : 'transcript', '2c',
            permission(j.certain, 'subagent', j.call));
        }
      }
    }

    // Rule 3 (only without a usable registry status): no hook file at all.
    if (!hook) {
      const c = oldest(qualifying.filter((x) => x.atMs != null && now - x.atMs > promptAfterMs));
      if (c) return result('prompt', c.atMs, 'transcript', '3', permission(false, 'main', c));
    }
  }

  // Rule 5: Colony's decideState as fallback.
  const call = oldest(qualifying);
  const f = cfg.fallback;
  const pendingBase = call ? (call.atMs ?? lastMs) : null;
  const r = decideState({
    isOpen: true,
    sub: false,
    hookStatus: hook?.status ?? null,
    hookSinceMs: hook?.sinceMs ?? null,
    open: Boolean(call),
    openTool: call?.name ?? null,
    openSinceMs: call?.atMs ?? null,
    pendingMin: pendingBase == null ? null : (now - pendingBase) / MIN,
    // No role record at all: infinitely old, so decideState cannot guess 'working' from `null <= n`.
    ageMin: lastMs == null ? Infinity : (now - lastMs) / MIN,
    recType: lastType,
    thresholds: { agentWorkingMinutes: f.workingMinutes, agentPromptMinutes: f.promptMinutes, agentWaitingMinutes: f.waitingMinutes },
  });
  let state = r.state;
  if (state === 'waiting' && lastMs != null && now - lastMs > cfg.idleAfterMinutes * MIN) state = 'idle';
  if (state === 'prompt') {
    return result('prompt', call ? call.atMs ?? null : lastMs ?? null, r.statusSource, '5', permission(false, 'main', call ?? null));
  }
  return result(state, lastMs ?? null, r.statusSource, '5');
}
