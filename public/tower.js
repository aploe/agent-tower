// Widget page. Live mode follows the daemon's event stream. Fixture mode (?fixture=<name>)
// renders public/fixtures/<name>.json with its generatedAt as "now", so screenshots stay the
// same over time; its actions do nothing. In fixture mode ?lang=de shows the page in German
// (live mode follows the daemon's setting) and ?offline=1 shows it as while the daemon is
// unreachable.
import { renderDetail, renderHeader, renderList, renderSettings } from './modules/render.mjs';
import { assignHues } from './modules/figure.mjs';
import { answer as sendAnswer, getSettings, getSteps, post, setSettings, subscribe } from './modules/api.mjs';
import { ARM_MS, layoutSignature, requestsOf, toggleChoice } from './modules/answer.mjs';
import { createBridge } from './modules/bridge.mjs';
import { LANGUAGES, S, setLanguage } from './strings.mjs';

const TIMES_MS = 10000; // relative times move on without a new snapshot
const STEPS_MS = 2000; // the open detail view asks for its steps this often
const REASON_MS = 4000; // how long a refusal stays in its row
const ANSWER_MS = 2000; // a setting without an answer by then goes back
const HOLD_MS = 1500; // longest time a held pointer keeps the page from rebuilding
const LANGUAGE_WAIT_MS = 1500; // the first render waits this long at most for the language setting

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture');
const langParam = params.get('lang');
const app = document.getElementById('app');
const bridge = createBridge();

const ui = {
  selectedId: params.get('detail'),
  collapsed: params.get('collapsed') === '1',
  showHidden: false,
  online: !(fixture && params.get('offline') === '1'), // live mode: the event stream says; ?offline=1 shows a fixture as the stale list

  canHide: bridge.inShell || Boolean(fixture), // a browser tab has nothing to hide; the mock shows the shell's look
  reasons: new Map(),
  hues: new Map(), // session id → figure colour, held while the session is listed
  settingsOpen: params.get('settings') === '1',
  // Answering held permission requests, by request id:
  choices: new Map(), // the options picked so far in a question block (every render rebuilds the DOM)
  sending: new Set(), // answered here; its controls stay off until the request leaves the snapshot
  armAt: 0, // performance.now() from which the answer controls take clicks again
};
const CHIPS = [30, 60, 120, 240, 480]; // minutes; a value from a config file joins them
// What the settings view shows. null: not known (the control is disabled, no state).
const settings = { autostart: null, topmost: null, idle: null, language: null, answerInWidget: null };
const pendingOption = new Map(); // key → { want, prev, timer } while the shell has not answered
let slide = null; // { key, to }: the switch to animate in the next render only (a render rebuilds the DOM, so a CSS transition cannot run)
let snapshot = { counts: { total: 0, prompt: 0, dismissed: 0 }, sessions: [] };
let steps = null; // null: not loaded (the detail view shows no step list at all)
let stepsOf = null; // the session id `steps` belongs to
let stepsSig = '';
let fixtureNow = Date.now();
let clockSkew = 0; // daemon clock minus this clock: relative times follow the daemon's clock
let lastView = 'list';
let listScrollY = 0;
let lastHeight = -1;
let lastAttention = -1;
let lastLayout = ''; // where the answer controls sat after the last render

const now = () => (fixture ? fixtureNow : Date.now() + clockSkew);

// ---------- rendering ----------

function render() {
  const selected = ui.selectedId ? snapshot.sessions.find((s) => s.id === ui.selectedId) : null;
  if (!selected) ui.selectedId = null;
  if ((snapshot.counts?.dismissed ?? 0) === 0) ui.showHidden = false;
  ui.hues = assignHues(snapshot.sessions, ui.hues);
  // What was picked or sent for a request is forgotten once the request is gone.
  const heldIds = new Set(snapshot.sessions.flatMap((s) => requestsOf(s).map((r) => r.id)));
  for (const id of ui.choices.keys()) if (!heldIds.has(id)) ui.choices.delete(id);
  for (const id of ui.sending) if (!heldIds.has(id)) ui.sending.delete(id);
  const view = ui.settingsOpen ? 'settings' : selected ? 'detail' : 'list';
  const y = window.scrollY;
  if (lastView === 'list') listScrollY = y;

  // Every render builds the page anew. A negative delay puts the new animations into the
  // phase the old ones were in, so the floating figure and the spinner do not jump.
  const t = Math.round(performance.now());
  app.style.setProperty('--phase-float', `-${t % 6000}ms`);
  app.style.setProperty('--phase-spin', `-${t % 1100}ms`);

  app.replaceChildren();
  const slideNow = slide;
  slide = null; // one render only: later renders (snapshot, 10 s tick) must not replay it
  if (ui.settingsOpen) {
    const idleValue = settings.idle;
    const choices = idleValue == null || CHIPS.includes(idleValue) ? CHIPS : [...CHIPS, idleValue].sort((a, b) => a - b);
    const model = {
      shell: bridge.inShell || fixture ? { autostart: settings.autostart, topmost: settings.topmost } : null,
      answerInWidget: settings.answerInWidget,
      idle: { value: idleValue, choices },
      language: { value: settings.language, choices: LANGUAGES },
      reasons: ui.reasons,
      slide: slideNow,
    };
    renderSettings(app, model, handlers, ui);
  } else if (selected) {
    renderDetail(app, selected, stepsOf === selected.id ? steps : null, now(), handlers, snapshot, ui);
  } else {
    renderHeader(app, snapshot, ui, handlers);
    if (!ui.collapsed) renderList(app, snapshot, now(), handlers, ui);
  }
  window.scrollTo(0, view === lastView ? y : view === 'list' ? listScrollY : 0);
  lastView = view;
  const height = Math.ceil(app.scrollHeight);
  if (height !== lastHeight) {
    lastHeight = height;
    bridge.resize(height);
  }
  // A click that was already on its way must not allow a command: whenever an answer block
  // appeared, left or moved, the view changed, or the page height did (the shell keeps the
  // window's bottom edge, so everything moves on screen), the controls rest for a moment.
  const blocks = [...app.querySelectorAll('[data-request]')].map((el) => ({
    id: el.dataset.request,
    top: Math.round(el.getBoundingClientRect().top + window.scrollY),
  }));
  const layout = layoutSignature({ view, height, blocks });
  if (layout !== lastLayout) {
    lastLayout = layout;
    ui.armAt = performance.now() + ARM_MS;
  }
  document.body.dataset.ready = '1';
}

// A click is pointer down and up on the same element. Rebuilding the page in between would
// swallow it, so a render waits while a pointer is held (but never longer than HOLD_MS: a
// window drag started from the header may never report the release).
let held = false;
let holdTimer = null;
let queued = false;

function flush() {
  if (!queued || held) return;
  queued = false;
  render();
}
function scheduleRender() {
  if (queued) return;
  queued = true;
  queueMicrotask(flush);
}
function release() {
  if (!held) return;
  held = false;
  clearTimeout(holdTimer);
  setTimeout(flush); // after the click that belongs to this release
}
window.addEventListener('pointerdown', (e) => {
  // The header outside its buttons moves the window; no click follows a drag.
  if (e.button === 0 && e.target.closest?.('.header, .detail-header') && !e.target.closest('button')) {
    bridge.drag();
    return;
  }
  held = true;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(release, HOLD_MS);
}, true);
window.addEventListener('pointerup', release, true);
window.addEventListener('pointercancel', release, true);
window.addEventListener('blur', release);

// ---------- data ----------

function takeSnapshot(next) {
  snapshot = next;
  const at = Date.parse(next.generatedAt);
  if (Number.isFinite(at)) clockSkew = at - Date.now();
  const asking = next.counts?.prompt ?? 0;
  if (asking !== lastAttention) {
    lastAttention = asking;
    bridge.attention(asking); // not tied to rendering: it must reach the tray while the window is hidden
  }
  scheduleRender();
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Loads the steps of the selected session; a failed load keeps what is shown. */
async function refreshSteps() {
  const id = ui.selectedId;
  if (!id || (!fixture && !ui.online)) return;
  let answer;
  try {
    answer = fixture ? await getJson(`fixtures/${encodeURIComponent(fixture)}.steps.json`) : await getSteps(id);
  } catch {
    return;
  }
  if (ui.selectedId !== id) return; // another row was picked while this one loaded
  const sig = JSON.stringify(answer);
  if (stepsOf === id && sig === stepsSig) return;
  steps = answer;
  stepsOf = id;
  stepsSig = sig;
  scheduleRender();
}

const reasonTimers = new Map();
function showReason(id, text) {
  ui.reasons.set(id, text);
  clearTimeout(reasonTimers.get(id));
  reasonTimers.set(id, setTimeout(() => {
    ui.reasons.delete(id);
    reasonTimers.delete(id);
    scheduleRender();
  }, REASON_MS));
  scheduleRender();
}

function clearReason(id) {
  clearTimeout(reasonTimers.get(id));
  reasonTimers.delete(id);
  ui.reasons.delete(id);
  scheduleRender();
}

/** dismiss | restore: the daemon answers with the new snapshot. */
async function changeHidden(id, action) {
  if (fixture) return;
  const answer = await post(id, action);
  if (Array.isArray(answer.sessions)) takeSnapshot(answer);
  else showReason(id, answer.reason ?? S.offline);
}

// ---------- settings ----------
// A change shows at once; when the answer says otherwise, or none comes in time, the control
// goes back and its row says so for a moment. Reasons live in ui.reasons under 'autostart',
// 'topmost' and 'idle' (session ids never look like that).

function settleOption(key, now) {
  const p = pendingOption.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pendingOption.delete(key);
  if (now !== p.want) {
    settings[key] = p.prev;
    slide = { key, to: p.prev };
    showReason(key, S.notSaved);
  }
}

function changeOption(key, want) {
  if (fixture || pendingOption.has(key) || typeof settings[key] !== 'boolean') return;
  const timer = setTimeout(() => settleOption(key, undefined), ANSWER_MS);
  pendingOption.set(key, { want, prev: settings[key], timer });
  settings[key] = want;
  slide = { key, to: want };
  bridge.options({ [key]: want });
  scheduleRender();
}

bridge.onOptions((answer) => {
  for (const key of ['autostart', 'topmost']) {
    settings[key] = answer[key];
    settleOption(key, answer[key]);
  }
  scheduleRender();
});

// The daemon's settings in the view: field in `settings` → key and value type in the daemon.
const DAEMON = {
  idle: { key: 'idleAfterMinutes', type: 'number' },
  language: { key: 'language', type: 'string' },
  answerInWidget: { key: 'answerInWidget', type: 'boolean' },
};
const asks = { idle: 0, language: 0, answerInWidget: 0 }; // per field: only the answer to the newest request counts

/** Shows the page in `code` and tells the shell; an unknown code changes nothing. */
function useLanguage(code) {
  if (!setLanguage(code)) return;
  document.documentElement.lang = code;
  bridge.language(code);
}

function applySetting(field, value) {
  settings[field] = value;
  if (field === 'language' && value !== null) useLanguage(value);
}

async function changeSetting(field, value) {
  if (fixture) return;
  const { key, type } = DAEMON[field];
  const prev = settings[field];
  const ask = ++asks[field];
  applySetting(field, value);
  scheduleRender();
  const request = setSettings({ [key]: value });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ANSWER_MS, null); });
  const answer = await Promise.race([request, timeout]);
  clearTimeout(timer);
  if (ask !== asks[field]) return; // a later pick replaced this one
  if (answer === null) {
    // Too slow: show the old value and say so, but the daemon may still apply the change.
    applySetting(field, prev);
    showReason(field, S.notSaved);
    const late = await request;
    const saved = late?.values?.[key];
    if (ask === asks[field] && saved === value) {
      applySetting(field, saved);
      clearReason(field);
    }
    return;
  }
  const got = answer.values?.[key];
  if (got === value) return;
  applySetting(field, typeof got === type ? got : prev);
  showReason(field, answer.reason ?? S.notSaved);
}

/** At start and on opening: ask the shell and the daemon. An old shell or daemon never answers; the controls stay disabled. */
async function loadSettings() {
  bridge.options();
  const ask = Object.fromEntries(Object.keys(DAEMON).map((field) => [field, ++asks[field]]));
  try {
    const values = (await getSettings())?.values ?? {};
    for (const [field, { key, type }] of Object.entries(DAEMON)) {
      if (ask[field] === asks[field] && typeof values[key] === type) applySetting(field, values[key]);
    }
    scheduleRender();
  } catch {
    // an older daemon has no settings: the chips stay disabled
  }
}

// ---------- actions ----------

const handlers = {
  settings() {
    ui.settingsOpen = true;
    scheduleRender();
    loadSettings();
  },
  closeSettings() {
    ui.settingsOpen = false;
    scheduleRender();
  },
  setOption: changeOption,
  setIdle: (minutes) => changeSetting('idle', minutes),
  setLanguage: (code) => changeSetting('language', code),
  /** Whether held permission requests can be answered here; a daemon setting like the two above. */
  setAnswerInWidget(want) {
    if (fixture) return;
    slide = { key: 'answerInWidget', to: want };
    changeSetting('answerInWidget', want);
  },
  select(id) {
    ui.selectedId = id;
    scheduleRender();
    refreshSteps();
  },
  back() {
    ui.selectedId = null;
    scheduleRender();
  },
  collapse() {
    ui.collapsed = !ui.collapsed;
    scheduleRender();
  },
  showHidden() {
    ui.showHidden = !ui.showHidden;
    scheduleRender();
  },
  async open(id) {
    if (fixture) return;
    const answer = await post(id, 'open');
    if (answer.ok !== true) showReason(id, answer.reason ?? S.offline);
  },
  dismiss: (id) => changeHidden(id, 'dismiss'),
  restore: (id) => changeHidden(id, 'restore'),
  hide: () => bridge.hide(),

  // --- answering a held permission request ---
  /** False for a moment after an answer block appeared or moved (see render). */
  armed: () => performance.now() >= ui.armAt,
  /** A click on option `index` of question `q` in a question block. */
  choose(requestId, questions, q, index) {
    ui.choices.set(requestId, toggleChoice(questions, ui.choices.get(requestId), q, index));
    scheduleRender();
  },
  /** Allow, Deny or Send. After a yes from the daemon the block stays switched off until the
   *  next snapshot no longer has the request; a refusal shows in the row and frees it again. */
  async answer(sessionId, requestId, body) {
    if (fixture || ui.sending.has(requestId)) return;
    ui.sending.add(requestId);
    scheduleRender();
    const result = await sendAnswer(sessionId, body);
    if (result.ok === true) return;
    ui.sending.delete(requestId);
    showReason(sessionId, result.reason ?? S.offline);
  },
};

// ---------- start ----------

async function startFixture() {
  try {
    // No render before the steps are there: the screenshot tool shoots at the first one.
    snapshot = await getJson(`fixtures/${encodeURIComponent(fixture)}.json`);
    fixtureNow = Date.parse(snapshot.generatedAt);
    await refreshSteps();
  } catch (err) {
    console.error(err);
  }
  if (ui.settingsOpen) {
    // fixed values for screenshots
    Object.assign(settings, {
      autostart: true, topmost: true, idle: 240, answerInWidget: true, language: LANGUAGES.includes(langParam) ? langParam : 'en',
    });
  }
  scheduleRender();
}

async function startLive() {
  // The language first, so the first render does not show the wrong one for a moment.
  await Promise.race([loadSettings(), new Promise((resolve) => setTimeout(resolve, LANGUAGE_WAIT_MS))]);
  subscribe(takeSnapshot, (status) => {
    ui.online = status === 'online';
    scheduleRender();
    if (ui.online) refreshSteps();
  });
  setInterval(scheduleRender, TIMES_MS);
  setInterval(refreshSteps, STEPS_MS);
}

if (fixture) {
  if (langParam) useLanguage(langParam);
  startFixture();
} else {
  startLive();
}
// The page can change its size without a render: the fonts arrive after the first one and
// move things by a few pixels. Render again then, so that the window height and the remembered
// place of the answer controls are those of the layout on screen. (Without this the next
// render saw a "move" that was long over, and the controls ignored the click after it.)
// Never before the first regular render: that one waits for its data, and an earlier, empty
// render would drop the selected session and tell the screenshot tool the page is ready.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (document.body.dataset.ready === '1') scheduleRender();
  }).observe(app);
}
