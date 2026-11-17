// Pure helpers: turn tool calls into step labels, permission-prompt summaries,
// AskUserQuestion questions and the "terminal" box. Never throws on odd input.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function host(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function stepLabel(name, input) {
  const i = isObj(input) ? input : {};
  let label = null;
  switch (name) {
    case 'Bash':
      label = str(i.description) ?? (str(i.command) ? cap(i.command, 80) : null);
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      label = str(i.file_path) ? baseName(i.file_path) : null;
      break;
    case 'Agent':
      label = str(i.description);
      break;
    case 'Skill':
      label = str(i.skill);
      break;
    case 'WebFetch':
      label = str(i.url) ? host(i.url) : null;
      break;
    case 'WebSearch':
      label = str(i.query);
      break;
    case 'Grep':
    case 'Glob':
      label = str(i.pattern);
      break;
  }
  return label ?? String(name);
}

export function askSummary(name, input) {
  if (!isObj(input)) return null;
  let s = null;
  switch (name) {
    case 'Bash':
      s = str(input.command);
      break;
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      s = str(input.file_path);
      break;
    case 'WebFetch':
      s = str(input.url);
      break;
    default:
      try {
        s = JSON.stringify(input);
      } catch {
        s = null;
      }
  }
  return s === null ? null : cap(s, 200);
}

export function questionsOf(input) {
  if (!isObj(input) || !Array.isArray(input.questions)) return null;
  const out = [];
  for (const q of input.questions) {
    if (!isObj(q) || typeof q.question !== 'string') return null;
    const rawOptions = q.options === undefined ? [] : q.options;
    if (!Array.isArray(rawOptions)) return null;
    const options = [];
    for (const o of rawOptions) {
      if (typeof o === 'string') options.push(o);
      else if (isObj(o) && typeof o.label === 'string') options.push(o.label);
      else return null;
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

// ---------- held permission requests ----------
// What the widget shows above its answer buttons. Nothing here is shortened: a request whose
// text does not fit is not offered for answering at all (null).

export const MAX_DETAIL = 4000;

/** The field that names what a tool is about to do, and whether its other inputs are listed. */
const DETAIL_FIELD = {
  Bash: { main: 'command', listOthers: true, skip: ['description'] },
  WebFetch: { main: 'url', listOthers: true, skip: [] },
  Write: { main: 'file_path', listOthers: false },
  Edit: { main: 'file_path', listOthers: false },
  NotebookEdit: { main: 'file_path', listOthers: false },
};

/**
 * { detail, extras } for a permission request, or null when it cannot be shown in full.
 * extras lists the call's other inputs as "key: <JSON>" lines: a call can need permission
 * because of one of them (leaving the sandbox), so they must be visible. File tools show the
 * path only; their content fields are left out on purpose.
 */
export function requestDetail(tool, input) {
  if (!isObj(input)) return null;
  const spec = DETAIL_FIELD[tool];
  let detail;
  let extras = [];
  if (spec) {
    detail = str(input[spec.main]);
    if (detail === null) return null;
    if (spec.listOthers) {
      extras = Object.keys(input)
        .filter((key) => key !== spec.main && !spec.skip.includes(key))
        .map((key) => `${key}: ${JSON.stringify(input[key])}`);
    }
  } else {
    try {
      detail = JSON.stringify(input);
    } catch {
      return null;
    }
  }
  const length = extras.reduce((sum, line) => sum + line.length, detail.length);
  return length > MAX_DETAIL ? null : { detail, extras };
}

/**
 * The questions of an AskUserQuestion request in the shape the widget answers by index, or
 * null when that is not possible: 1 to 4 questions, each with at least two options that carry
 * a label, question texts unique (the answer is keyed by them), labels unique per question.
 */
export function requestQuestions(input) {
  if (!isObj(input) || !Array.isArray(input.questions)) return null;
  if (input.questions.length < 1 || input.questions.length > 4) return null;
  const out = [];
  const texts = new Set();
  for (const q of input.questions) {
    if (!isObj(q) || typeof q.question !== 'string' || texts.has(q.question)) return null;
    texts.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    const labels = new Set();
    const options = [];
    for (const o of q.options) {
      if (!isObj(o) || typeof o.label !== 'string' || labels.has(o.label)) return null;
      labels.add(o.label);
      options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : '' });
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

export function planSummary(input) {
  if (!isObj(input) || typeof input.plan !== 'string') return null;
  const line = input.plan.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? cap(line, 200) : null;
}

function lastNonEmptyLine(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  return lines.length ? cap(lines[lines.length - 1], 160) : null;
}

/** How many of the latest tool calls the detail view lists (André, 2026-11-17: 30, was 15). */
export const STEP_LIMIT = 30;

export function buildSteps(calls, limit = STEP_LIMIT) {
  const list = Array.isArray(calls) ? calls : [];
  const steps = list.slice(-limit).map((c) => ({
    tool: c.name,
    label: stepLabel(c.name, c.input),
    status: c.status,
    at: typeof c.atMs === 'number' ? new Date(c.atMs).toISOString() : null,
  }));
  let terminal = null;
  for (let k = list.length - 1; k >= 0; k--) {
    if (list[k].name !== 'Bash') continue;
    const cmd = isObj(list[k].input) ? str(list[k].input.command) : null;
    terminal = { command: cmd ? cap(cmd, 200) : '', lastLine: lastNonEmptyLine(list[k].resultText) };
    break;
  }
  return { steps, terminal };
}
