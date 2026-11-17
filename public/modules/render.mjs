// DOM for the widget. Everything is built with createElement and text nodes; session text
// never passes through innerHTML (project rule). Icons and the figure are fixed SVG shapes.
import { S } from '../strings.mjs';
import { duration, relTime, stateLine, stateMark, thirdLine, unreadable } from './format.mjs';
import { hueIndex } from './figure.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c); // strings become text nodes
  }
  return el;
}

function h(tag, opts = {}, ...children) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.tip) el.title = opts.tip;
  if (opts.label) el.setAttribute('aria-label', opts.label);
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) el.style.setProperty(k, v);
  if (opts.on) for (const [ev, fn] of Object.entries(opts.on)) el.addEventListener(ev, fn);
  if (tag === 'button') el.type = 'button';
  return append(el, children);
}

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return append(el, children);
}

// ---------- icons (24 × 24, line) ----------

const ICONS = {
  open: ['M8.5 3.5h7a5 5 0 0 1 5 5v7a5 5 0 0 1-5 5h-7a5 5 0 0 1-5-5v-7a5 5 0 0 1 5-5z', 'M9.5 14.5l5-5', 'M10 9.5h4.5V14'],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  up: ['M6 14.5l6-6 6 6'],
  down: ['M6 9.5l6 6 6-6'],
  back: ['M14.5 6l-6 6 6 6'],
  restore: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3', 'M4.5 4.5v4h4'],
  terminal: ['M6 3.5h12a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5z', 'M7.5 9.5l3 2.5-3 2.5', 'M12.5 15h4'],
  pencil: ['M4.5 19.5h4l10-10-4-4-10 10z', 'M13 7l4 4'],
  file: ['M7 3.5h6.5l4.5 4.5v12.5H7z', 'M13.5 3.5V8H18'],
  search: ['M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12z', 'M15 15l4.5 4.5'],
  globe: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M3.5 12h17', 'M12 3.5c2.4 2.6 2.4 14.4 0 17', 'M12 3.5c-2.4 2.6-2.4 14.4 0 17'],
  agent: ['M12 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z', 'M5.5 19.5c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5'],
  gear: ['M12 3.5l1.2 2.2 2.4-.7.9 2.3 2.3.9-.7 2.4 2.2 1.2-2.2 1.2.7 2.4-2.3.9-.9 2.3-2.4-.7L12 20.5l-1.2-2.2-2.4.7-.9-2.3-2.3-.9.7-2.4L4.5 12l2.2-1.2-.7-2.4 2.3-.9.9-2.3 2.4.7z', 'M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
  eyeOff: ['M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6z', 'M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z', 'M5 19L19 5'],
  tool: ['M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z'],
};

function icon(name) {
  const paths = ICONS[name] ?? ICONS.tool;
  return s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...paths.map((d) => s('path', { d })));
}

const TOOL_ICON = {
  Bash: 'terminal', BashOutput: 'terminal', Read: 'file', Edit: 'pencil', Write: 'pencil', NotebookEdit: 'pencil',
  Grep: 'search', Glob: 'search', WebFetch: 'globe', WebSearch: 'globe', Agent: 'agent', Task: 'agent',
};

function stepMark(status) {
  const a = { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' };
  if (status === 'done') {
    return h('span', { class: 'mark done' }, s('svg', a,
      s('circle', { cx: 12, cy: 12, r: 9, fill: 'currentColor' }),
      s('path', { d: 'M8 12.3l2.8 2.7L16.2 9.6', stroke: 'var(--card)', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
  }
  if (status === 'error') {
    return h('span', { class: 'mark error' }, s('svg', a,
      s('circle', { cx: 12, cy: 12, r: 8.2, stroke: 'currentColor', 'stroke-width': 1.8 }),
      s('path', { d: 'M12 7.8v5', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }),
      s('circle', { cx: 12, cy: 16.2, r: 1.2, fill: 'currentColor' })));
  }
  return h('span', { class: 'mark running' }, s('svg', a,
    s('circle', { cx: 12, cy: 12, r: 8.2, stroke: 'rgb(255 255 255 / 0.15)', 'stroke-width': 2 }),
    s('circle', { cx: 12, cy: 12, r: 8.2, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': '14 38' })));
}

/** Before the state line: a lime spinner while working, a dot when finished (lime: VS Code marks
 *  it unread, grey: read). */
function stateRow(session, line) {
  const mark = stateMark(session);
  let lead = null;
  if (mark === 'spin') {
    lead = h('span', { class: 'state-spin' }, s('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
      s('circle', { class: 'track', cx: 12, cy: 12, r: 9, 'stroke-width': 3.2 }),
      s('circle', { class: 'arc', cx: 12, cy: 12, r: 9, 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-dasharray': '16 41' })));
  } else if (mark) {
    lead = h('span', { class: 'state-dot' + (mark === 'unread' ? ' is-unread' : '') });
  }
  return h('div', { class: `state tone-${line.tone}` }, lead, h('span', { class: 'state-text' }, line.text));
}

// ---------- figure ----------

const hueVar = (id, ui) => `var(--hue-${ui.hues?.get(id) ?? hueIndex(id)})`;

/** Own figure: a rounded head with an antenna, two round eyes, a small smile, no legs (not the reel's mascot). */
function figure(id, ui, { working = false, size = 38 } = {}) {
  const svg = s('svg', { class: 'figure' + (working ? ' is-working' : ''), viewBox: '0 0 40 46', width: size, height: size * 46 / 40, 'aria-hidden': 'true' },
    s('ellipse', { class: 'shadow', cx: 20, cy: 43.5, rx: 11, ry: 2.2 }),
    s('g', { class: 'float' },
      s('path', { class: 'body', d: 'M19 5h2v6h-2z' }),
      s('circle', { class: 'body', cx: 20, cy: 4.5, r: 3.2 }),
      s('rect', { class: 'body', x: 5, y: 9.5, width: 30, height: 28, rx: 11 }),
      s('circle', { class: 'eye', cx: 14.5, cy: 22.5, r: 3 }),
      s('circle', { class: 'eye', cx: 25.5, cy: 22.5, r: 3 }),
      s('path', { class: 'mouth', d: 'M16 29.2Q20 33 24 29.2' })));
  svg.style.setProperty('--fig', hueVar(id, ui));
  return svg;
}

function face(session, ui, onClick) {
  const eyes = s('svg', { viewBox: '0 0 14 12', 'aria-hidden': 'true' },
    s('circle', { cx: 3.5, cy: 3.5, r: 2.1, fill: 'var(--eye)' }),
    s('circle', { cx: 10.5, cy: 3.5, r: 2.1, fill: 'var(--eye)' }),
    s('path', { class: 'mouth', d: 'M5 8.2Q7 10.4 9 8.2' }));
  return h('button', {
    class: 'face' + (session.state === 'prompt' ? ' is-ask' : ''),
    tip: session.title,
    label: session.title,
    style: { '--fig': hueVar(session.id, ui) },
    on: { click: onClick },
  }, eyes);
}

// ---------- small parts ----------

function iconButton(name, label, onClick) {
  return h('button', {
    class: 'icon-btn',
    tip: label,
    label,
    on: { click: (e) => { e.stopPropagation(); onClick(); } },
  }, icon(name));
}

// The collapse chevron shows where the panel goes: the window sits at the bottom of the screen
// and opens upwards, so "down" folds it away and "up" opens it (André, 2026-11-17).

/** What a click opens: the desktop app for its sessions, VS Code for the rest. */
function openLabel(session) {
  return session.opensIn === 'desktop' ? S.openInDesktop : S.openInVsCode;
}

function rowActions(session, handlers) {
  const open = session.canOpen
    ? iconButton('open', openLabel(session), () => handlers.open(session.id))
    : h('span', { class: 'icon-spacer' });
  const cross = session.dismissed
    ? iconButton('restore', S.restore, () => handlers.restore(session.id))
    : iconButton('close', S.dismiss, () => handlers.dismiss(session.id));
  return [open, cross];
}

function openPill(session, handlers) {
  if (!session.canOpen) return null;
  return h('div', { class: 'pills' },
    h('button', { class: 'pill', on: { click: (e) => { e.stopPropagation(); handlers.open(session.id); } } }, openLabel(session)));
}

function askBlock(session, handlers) {
  const ask = session.ask;
  if (!ask) return h('div', { class: 'ask' }, openPill(session, handlers));
  if (ask.kind === 'question' && Array.isArray(ask.questions) && ask.questions.length) {
    const q = ask.questions[0];
    return h('div', { class: 'ask' },
      h('div', { class: 'question-box' },
        q.header ? h('span', { class: 'chip' }, q.header) : null,
        h('div', { class: 'question' }, q.question ?? ''),
        h('ul', { class: 'options' },
          ...(q.options ?? []).map((o) => h('li', {}, String(o))))),
      openPill(session, handlers));
  }
  const summary = ask.summary
    ? h('div', { class: 'command', tip: ask.summary },
        ask.kind === 'plan' ? null : h('span', { class: 'tool' }, ask.tool ? `${ask.tool}: ` : ''),
        ask.summary)
    : null;
  return h('div', { class: 'ask' }, summary, openPill(session, handlers));
}

function card(session, nowMs, handlers, ui) {
  const line = stateLine(session);
  const classes = ['card'];
  if (session.state === 'prompt') classes.push(line.tone === 'ask' ? 'is-ask' : 'is-ask-weak');
  if (session.dismissed) classes.push('is-dismissed');
  const reason = ui.reasons?.get(session.id);
  return h('article', { class: classes.join(' '), on: { click: () => handlers.select(session.id) } },
    h('div', { class: 'fig-cell' }, figure(session.id, ui, { working: session.state === 'working' })),
    h('div', { class: 'lines' },
      h('div', { class: 'title', tip: session.title }, session.title),
      stateRow(session, line),
      h('div', { class: 'meta', tip: session.cwd }, thirdLine(session, nowMs))),
    h('div', { class: 'actions' }, ...rowActions(session, handlers)),
    session.state === 'prompt' ? askBlock(session, handlers) : null,
    reason ? h('div', { class: 'reason' }, reason) : null);
}

function lineRow(session, nowMs, handlers, ui) {
  const reason = ui.reasons?.get(session.id);
  return h('div', { class: 'line-row' + (session.dismissed ? ' is-dismissed' : ''), on: { click: () => handlers.select(session.id) } },
    figure(session.id, ui, { size: 17 }),
    h('div', { class: 'title', tip: reason || session.title }, reason || session.title),
    h('div', { class: 'time' }, relTime(session.stateSince, nowMs)),
    ...rowActions(session, handlers));
}

/** Shown in every view while the daemon is silent: what is on screen may be out of date. */
function banner(ui) {
  return ui.online === false ? h('div', { class: 'banner' }, S.offline) : null;
}

/** A side the daemon could not read: its rows are missing, not ended (project rule: unknown is
 *  shown as unknown). Not while offline: then the whole snapshot is old and the offline banner says so. */
function sourceBanner(snapshot, ui) {
  const text = ui.online === false ? null : unreadable(snapshot?.sources);
  return text ? h('div', { class: 'banner' }, text) : null;
}

const stale = (ui) => (ui.online === false ? ' is-stale' : '');

// ---------- public ----------

export function renderHeader(root, snapshot, ui, handlers) {
  const counts = snapshot?.counts ?? { total: 0, prompt: 0, dismissed: 0 };
  root.append(h('header', { class: 'header' + (ui.online === false ? ' is-offline' : '') },
    h('span', { class: 'dot', tip: ui.online === false ? S.offline : '' }),
    h('span', { class: 'name' }, S.title),
    h('span', { class: 'count' }, String(counts.total)),
    counts.prompt > 0 ? h('span', { class: 'asking' }, '· ' + S.asking(counts.prompt)) : null,
    h('span', { class: 'spacer' }),
    counts.dismissed > 0
      ? h('button', { class: 'hidden-toggle' + (ui.showHidden ? ' is-on' : ''), tip: S.hidden(counts.dismissed), label: S.hidden(counts.dismissed), on: { click: handlers.showHidden } },
          icon('eyeOff'), h('span', {}, String(counts.dismissed)))
      : null,
    // The three window buttons never shrink or leave the header; when it gets tight the
    // information on the left is cut instead (André, 2026-11-17).
    h('div', { class: 'nav' },
      iconButton('gear', S.settings, handlers.settings),
      iconButton(ui.collapsed ? 'up' : 'down', ui.collapsed ? S.expand : S.collapse, handlers.collapse),
      ui.canHide ? iconButton('close', S.close, handlers.hide) : null)));
  append(root, [banner(ui), sourceBanner(snapshot, ui)]);
}

export function renderList(root, snapshot, nowMs, handlers, ui) {
  const visible = snapshot.sessions.filter((x) => !x.dismissed || ui.showHidden);
  const list = h('section', { class: 'list' + stale(ui) });
  if (visible.length === 0) {
    // "none running" would be a claim the daemon cannot make while a side is unreadable
    if (!unreadable(snapshot.sources)) list.append(h('div', { class: 'empty' }, S.empty));
  } else {
    for (const session of visible) {
      list.append(session.state === 'idle' ? lineRow(session, nowMs, handlers, ui) : card(session, nowMs, handlers, ui));
    }
  }
  root.append(list);
}

export function renderDetail(root, session, stepsAnswer, nowMs, handlers, snapshot, ui) {
  const others = (snapshot?.sessions ?? []).filter((x) => x.id !== session.id && !x.dismissed);
  root.append(h('header', { class: 'detail-header' },
    iconButton('back', S.back, handlers.back),
    h('div', { class: 'faces' }, ...others.map((o) => face(o, ui, () => handlers.select(o.id)))),
    session.canOpen ? iconButton('open', openLabel(session), () => handlers.open(session.id)) : null,
    iconButton(ui.collapsed ? 'up' : 'down', ui.collapsed ? S.expand : S.collapse, handlers.collapse),
    ui.canHide ? iconButton('close', S.close, handlers.hide) : null));
  append(root, [banner(ui)]);
  if (ui.collapsed) return;

  const line = stateLine(session);
  const steps = stepsAnswer?.steps ?? [];
  const terminal = stepsAnswer?.terminal ?? null;
  const reason = ui.reasons?.get(session.id);
  root.append(h('section', { class: 'detail-card' + (session.state === 'prompt' && line.tone === 'ask' ? ' is-ask' : '') + stale(ui) },
    h('div', { class: 'detail-top' },
      figure(session.id, ui, { working: session.state === 'working', size: 48 }),
      h('div', { class: 'lines' },
        h('div', { class: 'title', tip: session.title }, session.title),
        stateRow(session, line),
        h('div', { class: 'meta', tip: session.cwd }, thirdLine(session, nowMs)))),
    session.state === 'prompt' ? h('div', { class: 'detail-ask' }, askBlock(session, handlers)) : null,
    reason ? h('div', { class: 'reason' }, reason) : null,
    h('div', { class: 'divider' }),
    steps.length
      ? h('ul', { class: 'steps' }, ...steps.map((st) => h('li', { class: `step is-${st.status}` },
          stepMark(st.status),
          h('span', { class: 'tool', tip: st.tool }, icon(TOOL_ICON[st.tool] ?? 'tool')),
          h('span', { class: 'label', tip: st.label }, st.label))))
      : stepsAnswer ? h('div', { class: 'no-steps' }, S.noSteps) : null, // not loaded is not "none"
    terminal
      ? h('div', { class: 'terminal' },
          h('span', { class: 'tchip' }, icon('terminal'), S.terminal),
          h('div', { class: 'cmd', tip: terminal.command }, '$ ' + terminal.command),
          terminal.lastLine ? h('div', { class: 'out', tip: terminal.lastLine }, terminal.lastLine) : null)
      : null));
}

// ---------- settings ----------

/** A switch row; the whole row is the button. value null: not known yet, disabled, no state shown. */
function switchRow(label, key, value, reason, handlers, slide) {
  const known = typeof value === 'boolean';
  const row = h('button', {
    class: 'switch-row' + (value === true ? ' is-on' : '') + (slide?.key === key ? (slide.to ? ' slide-on' : ' slide-off') : ''),
    on: { click: () => known && handlers.setOption(key, !value) },
  }, h('span', { class: 'row-label' }, label), h('span', { class: 'switch' }, h('span', { class: 'knob' })));
  row.setAttribute('role', 'switch');
  if (known) row.setAttribute('aria-checked', String(value));
  else row.disabled = true;
  return h('div', { class: 'setting' }, row, reason ? h('div', { class: 'reason' }, reason) : null);
}

/**
 * The third view. model = { shell: null | { autostart, topmost }, idle: { value, choices },
 * reasons, slide } (values null while unknown; slide: { key, to } animates that switch once). shell: null hides the switches (a plain browser).
 */
export function renderSettings(root, model, handlers, ui) {
  root.append(h('header', { class: 'detail-header' },
    iconButton('back', S.back, handlers.closeSettings),
    h('span', { class: 'settings-title' }, S.settings),
    h('span', { class: 'spacer' }),
    iconButton(ui.collapsed ? 'up' : 'down', ui.collapsed ? S.expand : S.collapse, handlers.collapse),
    ui.canHide ? iconButton('close', S.close, handlers.hide) : null));
  append(root, [banner(ui)]);
  if (ui.collapsed) return;

  const { shell, idle, reasons } = model;
  const known = typeof idle.value === 'number';
  const idleReason = reasons.get('idle');
  root.append(h('section', { class: 'settings-card' + stale(ui) },
    shell ? switchRow(S.autostart, 'autostart', shell.autostart, reasons.get('autostart'), handlers, model.slide) : null,
    shell ? switchRow(S.topmost, 'topmost', shell.topmost, reasons.get('topmost'), handlers, model.slide) : null,
    shell ? h('div', { class: 'divider' }) : null,
    h('div', { class: 'setting idle' },
      h('div', { class: 'row-label' }, S.idleAfter),
      h('div', { class: 'hint' }, S.idleAfterHint),
      h('div', { class: 'choices' }, ...idle.choices.map((minutes) => {
        const chosen = minutes === idle.value;
        const btn = h('button', {
          class: 'choice' + (chosen ? ' is-on' : ''),
          on: { click: () => known && !chosen && handlers.setIdle(minutes) },
        }, duration(minutes));
        btn.setAttribute('aria-pressed', String(chosen));
        btn.disabled = !known;
        return btn;
      })),
      idleReason ? h('div', { class: 'reason' }, idleReason) : null)));
}
