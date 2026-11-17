// Every UI string of the widget. German only (spec §2); nothing else in public/ holds UI text.
export const S = {
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

  // state lines (spec §7.2, §8.3)
  working: 'arbeitet',
  waiting: 'fertig',
  idle: 'ruht',
  askPermission: 'braucht Freigabe',
  askPermissionSub: 'Subagent braucht Freigabe',
  askQuestion: 'stellt eine Frage',
  askPlan: 'wartet auf Plan-Freigabe',
  askUncertain: 'fragt vermutlich',

  // header and row actions
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

  // settings view
  settings: 'Einstellungen',
  autostart: 'Mit Windows starten',
  topmost: 'Immer im Vordergrund',
  idleAfter: 'Session ruht nach',
  idleAfterHint: 'Fertige Sessions rutschen danach in die schmale Zeile.',
  notSaved: 'Nicht gespeichert',
};
