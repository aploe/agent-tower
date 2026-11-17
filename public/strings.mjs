// Every UI string of the widget, in English (German until 2026-11-17); nothing else in
// public/ holds UI text.
export const S = {
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

  // settings view
  settings: 'Settings',
  autostart: 'Start with Windows',
  topmost: 'Always on top',
  idleAfter: 'Idle after',
  idleAfterHint: 'Finished sessions then shrink to a slim row.',
  notSaved: 'Not saved',
};
