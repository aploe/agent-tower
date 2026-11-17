// Permission requests that Claude Code's PermissionRequest hook hands to the daemon, held
// until the user answers them in the widget. This module is the rules only: no HTTP, no timers.
//
// The daemon never decides anything by itself. A decision exists only as the answer to one
// held request, built here from what the user clicked.
import { randomUUID } from 'node:crypto';
import { say } from './messages.mjs';
import { requestDetail, requestQuestions } from './steps.mjs';
import { UUID } from './vscode.mjs';

export const MAX_HELD = 50;
/** How long a new request may wait for its session to show up as asking before it counts as
 *  answered elsewhere: the hook call arrives a moment before the registry says "waiting". */
export const GRACE_MS = 3000;

/** What the deny button sends. `interrupt` makes it behave like "No" in the VS Code dialog: the
 *  session stops and waits. Claude Code then shows its own rejection text; the message is kept
 *  for versions that show it. */
export const DENY = { behavior: 'deny', message: 'Denied by the user in the Agent Tower widget.', interrupt: true };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const no = (why) => ({ hold: false, why });

/**
 * Whether a hook call is held for the widget. Everything that is not held gets "no decision"
 * at once and takes the path it takes without this tool.
 * session: the snapshot row with the payload's session id, or null.
 */
export function eligibility({ payload, session, enabled, heldCount }) {
  if (!enabled) return no('off');
  if (!isObj(payload) || payload.hook_event_name !== 'PermissionRequest' || typeof payload.session_id !== 'string'
    || !UUID.test(payload.session_id) || typeof payload.tool_name !== 'string' || !isObj(payload.tool_input)) {
    return no('payload');
  }
  // Only sessions that show their own dialog next to the widget: VS Code in WSL.
  if (!session || session.host !== 'wsl' || session.entrypoint !== 'claude-vscode') return no('session');
  const tool = payload.tool_name;
  if (tool === 'ExitPlanMode') return no('plan');

  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : null;
  const base = { sessionId: payload.session_id, agentId, via: agentId ? 'subagent' : 'main', tool };
  let request;
  if (tool === 'AskUserQuestion') {
    const questions = requestQuestions(payload.tool_input);
    if (!questions) return no('questions');
    request = { ...base, kind: 'question', detail: null, extras: [], questions, toolInput: payload.tool_input };
  } else {
    const shown = requestDetail(tool, payload.tool_input);
    if (!shown) return no('detail');
    request = { ...base, kind: 'permission', detail: shown.detail, extras: shown.extras, questions: null, toolInput: null };
  }
  if (heldCount >= MAX_HELD) return no('full');
  return { hold: true, request };
}

const refuse = (reason) => ({ ok: false, reason });

/** One entry of `choices` against its question: indices in range, no duplicates, exactly one
 *  for a single choice and at least one for a multiple choice. */
function validChoice(question, picked) {
  if (!Array.isArray(picked) || picked.length === 0) return false;
  if (!question.multiSelect && picked.length !== 1) return false;
  if (new Set(picked).size !== picked.length) return false;
  return picked.every((i) => Number.isInteger(i) && i >= 0 && i < question.options.length);
}

/**
 * The decision for a held request from the page's answer { behavior, choices }.
 * A question is answered with its own option labels, picked by index: the page never sends
 * answer text. Refusals here only meet a broken or foreign request, so they stay English.
 */
export function decisionFor(request, body) {
  const behavior = isObj(body) ? body.behavior : undefined;
  if (request.kind === 'question') {
    if (behavior !== 'allow') return refuse('A question can only be answered here');
    const { questions } = request;
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length !== questions.length
      || !questions.every((q, k) => validChoice(q, choices[k]))) {
      return refuse('Choices incomplete or invalid');
    }
    const answers = {};
    questions.forEach((q, k) => {
      const picked = new Set(choices[k]);
      // Option order, joined the way VS Code records a multiple choice.
      answers[q.question] = q.options.filter((_, i) => picked.has(i)).map((o) => o.label).join(', ');
    });
    return { ok: true, decision: { behavior: 'allow', updatedInput: { ...request.toolInput, answers } } };
  }
  if (behavior !== 'allow' && behavior !== 'deny') return refuse('Unknown answer');
  if (body.choices !== undefined) return refuse('Choices do not belong to a permission request');
  return { ok: true, decision: behavior === 'allow' ? { behavior: 'allow' } : DENY };
}

/**
 * Whether a dialog is open in the row's session, so that a held request can still be answered
 * there. The registry says so itself ("waiting"). The derived state is not enough: an open
 * question in the transcript makes a row "prompt" even for a run that shows no dialog, and
 * holding that request would keep the run waiting for nobody. Only when the registry has no
 * status at all (an older Claude Code) does the derived state decide.
 */
function waitsForUser(row) {
  return typeof row.registryStatus === 'string' ? row.registryStatus === 'waiting' : row.state === 'prompt';
}

/**
 * The held requests. `hold` takes the request from `eligibility` and a function that answers
 * the waiting hook call: respond(decision) with a decision, respond(null) for "no decision".
 * It is called at most once per request. A request ends in exactly one way:
 *
 *   E1  answered in the widget                                   → the decision
 *   E3  its session has been missing from the snapshots for
 *       longer than the grace                                    → no decision
 *   E4  no dialog is open in its session (see waitsForUser) and
 *       the request is older than the grace                      → no decision
 *   E5  answering was switched off                               → no decision
 *   E6  Claude Code closed the call                              → nothing to send
 *   E7  the daemon shuts down                                    → no decision
 *
 * E4 is how an answer given in the VS Code dialog is noticed: Claude Code leaves the hook call
 * open then, but the session goes back to work. Holding a request never ends another one: one
 * session can ask several things at once (parallel tool calls, subagents).
 */
export function createRequests({ now = Date.now, newId = randomUUID, graceMs = GRACE_MS, log = () => {} } = {}) {
  const held = new Map(); // id → request, in the order they arrived

  /** Takes the request out first, then tells Claude Code: a respond that throws (the socket is
   *  gone) must neither keep the request nor stop the others. */
  function end(id, ending, decision = null) {
    const r = held.get(id);
    if (!r) return false;
    held.delete(id);
    if (ending !== 'E6') {
      try {
        r.respond(decision);
      } catch {
        // nobody is listening any more
      }
    }
    log({ ending, behavior: decision?.behavior ?? null, tool: r.tool, heldMs: now() - r.receivedAt, session: r.sessionId.slice(0, 8) });
    return true;
  }

  return {
    get size() {
      return held.size;
    },

    hold(request, respond) {
      const id = newId();
      held.set(id, { ...request, id, receivedAt: now(), respond });
      return id;
    },

    answer(sessionId, requestId, body) {
      const r = held.get(requestId);
      if (!r || r.sessionId !== sessionId) return { ok: false, status: 200, reason: say('requestGone') };
      const verdict = decisionFor(r, body);
      if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason };
      end(requestId, 'E1', verdict.decision);
      return { ok: true };
    },

    reconcile(snapshot) {
      const rows = new Map((snapshot?.sessions ?? []).map((s) => [s.id, s]));
      let ended = 0;
      for (const r of [...held.values()]) {
        const row = rows.get(r.sessionId);
        if (!row) {
          // One snapshot without the session can be a torn read of its registry file, or a
          // registry that could not be read at all. Only an absence that lasts longer than the
          // grace counts as gone. It is not ridden out for longer either: a run without a
          // dialog must not wait on a daemon that cannot see whether it still asks.
          r.missingSince ??= now();
          if (now() - r.missingSince > graceMs) ended += end(r.id, 'E3');
          continue;
        }
        r.missingSince = null;
        if (!waitsForUser(row) && now() - r.receivedAt > graceMs) ended += end(r.id, 'E4');
      }
      return ended;
    },

    endAll(ending) {
      let ended = 0;
      for (const id of [...held.keys()]) ended += end(id, ending);
      return ended;
    },

    drop(id) {
      end(id, 'E6');
    },

    listFor(sessionId) {
      const out = [];
      for (const r of held.values()) {
        if (r.sessionId !== sessionId) continue;
        out.unshift({
          id: r.id, kind: r.kind, via: r.via, tool: r.tool, detail: r.detail, extras: r.extras,
          questions: r.questions, since: new Date(r.receivedAt).toISOString(),
        });
      }
      return out;
    },
  };
}
