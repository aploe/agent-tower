// Widget page. Live mode follows the daemon's event stream. Fixture mode (?fixture=<name>)
// renders public/fixtures/<name>.json with its generatedAt as "now", so screenshots stay the
// same over time; its actions do nothing.
import { renderDetail, renderHeader, renderList, renderSettings } from './modules/render.mjs';
import { assignHues } from './modules/figure.mjs';
import { getSettings, getSteps, post, setSettings, subscribe } from './modules/api.mjs';
import { createBridge } from './modules/bridge.mjs';
import { S } from './strings.mjs';

const TIMES_MS = 10000; // relative times move on without a new snapshot
const STEPS_MS = 2000; // the open detail view asks for its steps this often
const REASON_MS = 4000; // how long a refusal stays in its row
const ANSWER_MS = 2000; // a setting without an answer by then goes back
const HOLD_MS = 1500; // longest time a held pointer keeps the page from rebuilding

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture');
const app = document.getElementById('app');
const bridge = createBridge();

const ui = {
  selectedId: params.get('detail'),
  collapsed: params.get('collapsed') === '1',
  showHidden: false,
  online: true,
  canHide: bridge.inShell || Boolean(fixture), // a browser tab has nothing to hide; the mock shows the shell's look
  reasons: new Map(),
  hues: new Map(), // session id → figure colour, held while the session is listed
  settingsOpen: params.get('settings') === '1',
};
const CHIPS = [30, 60, 120, 240, 480]; // minutes; a value from a config file joins them
// What the settings view shows. null: not known (the control is disabled, no state).
const settings = { autostart: null, topmost: null, idle: null };
const pendingOption = new Map(); // key → { want, prev, timer } while the shell has not answered
let slide = null; // { key, to }: the switch to animate in the next render only (a render rebuilds the DOM, so a CSS transition cannot run)
let settingsAsk = 0; // numbers the daemon requests; only the newest answer counts
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

const now = () => (fixture ? fixtureNow : Date.now() + clockSkew);

// ---------- rendering ----------

function render() {
  const selected = ui.selectedId ? snapshot.sessions.find((s) => s.id === ui.selectedId) : null;
  if (!selected) ui.selectedId = null;
  if ((snapshot.counts?.dismissed ?? 0) === 0) ui.showHidden = false;
  ui.hues = assignHues(snapshot.sessions, ui.hues);
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
      idle: { value: idleValue, choices },
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

async function changeIdle(minutes) {
  if (fixture) return;
  const prev = settings.idle;
  const ask = ++settingsAsk;
  settings.idle = minutes;
  scheduleRender();
  const request = setSettings({ idleAfterMinutes: minutes });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ANSWER_MS, null); });
  const answer = await Promise.race([request, timeout]);
  clearTimeout(timer);
  if (ask !== settingsAsk) return; // a later pick replaced this one
  if (answer === null) {
    // Too slow: show the old value and say so, but the daemon may still apply the change.
    settings.idle = prev;
    showReason('idle', S.notSaved);
    const late = await request;
    const saved = late?.values?.idleAfterMinutes;
    if (ask === settingsAsk && saved === minutes) {
      settings.idle = saved;
      clearReason('idle');
    }
    return;
  }
  const got = answer.values?.idleAfterMinutes;
  if (got === minutes) return;
  settings.idle = typeof got === 'number' ? got : prev;
  showReason('idle', answer.reason ?? S.notSaved);
}

/** On opening: ask the shell and the daemon. An old shell or daemon never answers; the controls stay disabled. */
async function loadSettings() {
  bridge.options();
  const ask = ++settingsAsk;
  try {
    const answer = await getSettings();
    const value = answer?.values?.idleAfterMinutes;
    if (ask === settingsAsk && typeof value === 'number') {
      settings.idle = value;
      scheduleRender();
    }
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
  setIdle: changeIdle,
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
    Object.assign(settings, { autostart: true, topmost: true, idle: 240 }); // fixed values for screenshots
  }
  scheduleRender();
}

function startLive() {
  subscribe(takeSnapshot, (status) => {
    ui.online = status === 'online';
    scheduleRender();
    if (ui.online) refreshSteps();
  });
  setInterval(scheduleRender, TIMES_MS);
  setInterval(refreshSteps, STEPS_MS);
}

if (fixture) startFixture();
else startLive();
if (!fixture && ui.settingsOpen) loadSettings();
