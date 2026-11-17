// Pure text helpers for rows: relative times and the state line. No DOM here.
import { S } from '../strings.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "40 s", "12 min", "6 h", "3 d"; unknown or unparseable → "—". */
export function relTime(sinceIso, nowMs) {
  if (typeof sinceIso !== 'string') return S.unknown;
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return S.unknown;
  const d = nowMs - t;
  if (d < 10 * SEC) return S.now;
  if (d < MIN) return `${Math.floor(d / SEC)} s`;
  if (d < HOUR) return `${Math.floor(d / MIN)} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  return `${Math.floor(d / DAY)} d`;
}

/** Second line of a row: what the session does, and how loud it should be. */
export function stateLine(session) {
  const normal = (text) => ({ text, tone: 'normal' });
  switch (session.state) {
    case 'working':
      return normal(session.current?.label || S.working);
    case 'waiting':
      return normal(S.waiting);
    case 'idle':
      return normal(S.idle);
    case 'prompt': {
      const ask = session.ask;
      if (!ask || !ask.certain) return { text: S.askUncertain, tone: 'askWeak' };
      if (ask.kind === 'question') return { text: S.askQuestion, tone: 'ask' };
      if (ask.kind === 'plan') return { text: S.askPlan, tone: 'ask' };
      const base = ask.via === 'subagent' ? S.askPermissionSub : S.askPermission;
      return { text: ask.tool ? `${base}: ${ask.tool}` : base, tone: 'ask' };
    }
    default:
      return normal(S.unknown);
  }
}

/**
 * What stands before the state line: 'spin' while working; for a finished session a dot,
 * 'unread' (lime) or 'read' (grey) as VS Code marks it. null: nothing (also when the read
 * state is not known, so no grey dot claims "read").
 */
export function stateMark(session) {
  if (session.state === 'working') return 'spin';
  if (session.state === 'waiting' && typeof session.unread === 'boolean') return session.unread ? 'unread' : 'read';
  return null;
}

/** Third line: project and time since the state began. */
export function thirdLine(session, nowMs) {
  return `${session.project} · ${relTime(session.stateSince, nowMs)}`;
}

/** A threshold in minutes: "30 min", "1 h", "90 min", "8 h" (hours when divisible by 60). */
export function duration(minutes) {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** The banner text when a side's sessions could not be read (its rows are then missing, not
 *  ended); null when nothing is missing. Hook and unread marks only add detail: not named. */
export function unreadable(sources) {
  const wsl = sources?.registry === false;
  const win = sources?.windows === false;
  if (wsl && win) return S.unreadableBoth;
  if (wsl) return S.unreadable('WSL');
  if (win) return S.unreadable('Windows');
  return null;
}
