// Refusals the widget can show in a row, in the language the user picked in the settings.
// Errors only a broken or foreign request meets (wrong origin, bad JSON, malformed ids) stay
// English and are not listed here.

const TEXT = {
  en: {
    noJump: () => 'This session cannot be opened from here',
    registryUnreadable: () => 'Registry not readable',
    unknownSession: () => 'Unknown session',
    noVsCodeServer: ({ base }) => `No VS Code server under ${base}; is VS Code running with the WSL remote?`,
    noRemoteCli: ({ base }) => `No remote-cli under ${base}/*/bin/remote-cli/code`,
    vscodeUnreachable: () => 'VS Code not reachable',
    windowsWithoutFolder: ({ n }) => `${n} windows without a folder; the title does not say which one`,
    windowsShowName: ({ n, name }) => `${n} windows show "${name}"; the title does not say which one`,
    twinFolders: ({ name, twins }) => `The window title only says "${name}", which also fits ${twins}; please open the window yourself`,
    noDistro: () => 'No WSL distro known (config.wslDistro)',
    windowNotFound: () => 'Window not found: no VS Code window has the folder open',
    noWslview: () => 'wslview missing (package wslu)',
  },
  de: {
    noJump: () => 'Für diese Session gibt es keinen Sprung',
    registryUnreadable: () => 'Registry nicht lesbar',
    unknownSession: () => 'Unbekannte Session',
    noVsCodeServer: ({ base }) => `Kein VS-Code-Server unter ${base}; läuft VS Code mit WSL-Remote?`,
    noRemoteCli: ({ base }) => `Keine remote-cli unter ${base}/*/bin/remote-cli/code`,
    vscodeUnreachable: () => 'VS Code nicht erreichbar',
    windowsWithoutFolder: ({ n }) => `${n} Fenster ohne Ordner; welches gemeint ist, sagt der Titel nicht`,
    windowsShowName: ({ n, name }) => `${n} Fenster zeigen "${name}"; welches gemeint ist, sagt der Titel nicht`,
    twinFolders: ({ name, twins }) => `Der Fenstertitel nennt nur "${name}", und so heißt auch ${twins}; bitte das Fenster selbst öffnen`,
    noDistro: () => 'Keine WSL-Distro bekannt (config.wslDistro)',
    windowNotFound: () => 'Fenster nicht gefunden: der Ordner ist in keinem VS-Code-Fenster offen',
    noWslview: () => 'wslview fehlt (Paket wslu)',
  },
};

export const LANGUAGES = Object.keys(TEXT);

let current = 'en';

/** Called by the app whenever the setting changes; an unknown code means English. */
export function setLanguage(code) {
  current = Object.hasOwn(TEXT, code) ? code : 'en';
}

/** The text for `key` in the current language. */
export function say(key, params = {}) {
  return TEXT[current][key](params);
}

/** For tests: every language must know every key. */
export const tables = TEXT;
