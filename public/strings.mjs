// Every UI string of the widget, per language; nothing else in public/ holds UI text.
// S always holds the current language: modules read S.x while they render, so a switch
// takes effect with the next render.

const EN = {
  title: 'Agent Tower',
  empty: 'No running sessions',
  offline: 'Daemon not reachable',
  unreadable: (side) => `${side} sessions not readable right now`,
  unreadableBoth: 'WSL and Windows sessions not readable right now',
  openInVsCode: 'Open in VS Code',
  openInDesktop: 'Open in the Claude app',
  terminal: 'Terminal',
  unknown: '—',
  now: 'now',

  // state lines (spec §7.2, §8.3)
  working: 'working',
  waiting: 'done',
  idle: 'idle',
  askPermission: 'needs permission',
  askPermissionSub: 'subagent needs permission',
  askQuestion: 'asks a question',
  askPlan: 'waits for plan approval',
  askUncertain: 'probably asking',

  // header and row actions
  hidden: (n) => `${n} hidden`,
  asking: (n) => `${n} asking`,
  collapse: 'Collapse',
  expand: 'Expand',
  hide: 'Hide',
  close: 'Close',
  dismiss: 'Hide',
  restore: 'Show again',
  back: 'Back',
  noSteps: 'No steps yet',

  // answering a permission request or a question in its row
  allow: 'Allow',
  deny: 'Deny',
  send: 'Send',

  // settings view
  settings: 'Settings',
  autostart: 'Start with Windows',
  topmost: 'Always on top',
  idleAfter: 'Idle after',
  idleAfterHint: 'Finished sessions then shrink to a slim row.',
  language: 'Language',
  answerInWidget: 'Answer in the widget',
  answerInWidgetHint: 'Answer permission prompts and questions right here. The dialog in VS Code keeps working.',
  notSaved: 'Not saved',
};

const DE = {
  title: 'Agent Tower',
  empty: 'Keine laufenden Sessions',
  offline: 'Dienst nicht erreichbar',
  unreadable: (side) => `${side}-Sessions gerade nicht lesbar`,
  unreadableBoth: 'WSL- und Windows-Sessions gerade nicht lesbar',
  openInVsCode: 'In VS Code öffnen',
  openInDesktop: 'In der Claude-App öffnen',
  terminal: 'Terminal',
  unknown: '—',
  now: 'jetzt',

  working: 'arbeitet',
  waiting: 'fertig',
  idle: 'ruht',
  askPermission: 'braucht Freigabe',
  askPermissionSub: 'Subagent braucht Freigabe',
  askQuestion: 'stellt eine Frage',
  askPlan: 'wartet auf Plan-Freigabe',
  askUncertain: 'fragt vermutlich',

  hidden: (n) => `${n} ausgeblendet`,
  asking: (n) => (n === 1 ? `${n} fragt` : `${n} fragen`),
  collapse: 'Einklappen',
  expand: 'Ausklappen',
  hide: 'Ausblenden',
  close: 'Schließen',
  dismiss: 'Ausblenden',
  restore: 'Wieder zeigen',
  back: 'Zurück',
  noSteps: 'Noch keine Schritte',

  allow: 'Erlauben',
  deny: 'Ablehnen',
  send: 'Senden',

  settings: 'Einstellungen',
  autostart: 'Mit Windows starten',
  topmost: 'Immer im Vordergrund',
  idleAfter: 'Session ruht nach',
  idleAfterHint: 'Fertige Sessions rutschen danach in die schmale Zeile.',
  language: 'Sprache',
  answerInWidget: 'Im Widget antworten',
  answerInWidgetHint: 'Freigaben und Fragen direkt hier beantworten. Der Dialog in VS Code bleibt nutzbar.',
  notSaved: 'Nicht gespeichert',
};

export const TABLES = { en: EN, de: DE };
export const LANGUAGES = Object.keys(TABLES);
/** Each language under its own name, the same in every table. */
export const LANGUAGE_NAMES = { en: 'English', de: 'Deutsch' };

export const S = { ...EN };

/** Switches S to `code`. Returns false (and changes nothing) for an unknown code. */
export function setLanguage(code) {
  if (!Object.hasOwn(TABLES, code)) return false;
  Object.assign(S, TABLES[code]);
  return true;
}
