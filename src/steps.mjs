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

export function buildSteps(calls, limit = 15) {
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
