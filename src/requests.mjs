// Permission requests that Claude Code's PermissionRequest hook hands to the daemon, held
// until the user answers them in the widget. This module is the rules only: no HTTP, no timers.
//
// The daemon never decides anything by itself. A decision exists only as the answer to one
// held request, built here from what the user clicked.
import { requestDetail, requestQuestions } from './steps.mjs';
import { UUID } from './vscode.mjs';

export const MAX_HELD = 50;

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
