// Messages from the page to the Windows shell (WebView2). In an ordinary browser there is
// no webview: every call does nothing and inShell is false.
export function createBridge(webview = globalThis.chrome?.webview) {
  const inShell = Boolean(webview);
  const send = (message) => {
    if (!inShell) return;
    try {
      webview.postMessage(message);
    } catch {
      // a shell that is going away must not break the page
    }
  };
  return {
    inShell,
    /** The panel's height in CSS pixels; the shell sizes its window to it. */
    resize: (height) => send({ type: 'resize', height }),
    /** The header was pressed: the shell starts moving the window. */
    drag: () => send({ type: 'drag' }),
    /** The header's X: the shell hides the window (it stays in the tray). */
    hide: () => send({ type: 'hide' }),
    /** How many sessions ask right now; the shell marks its tray icon. */
    attention: (count) => send({ type: 'attention', count }),
    /** The language the page shows ('en' | 'de'); the shell uses it for its tray menu and own pages. */
    language: (code) => send({ type: 'language', code }),
    /** Asks for the shell's options ({}), or sets some of them ({ autostart, topmost }). */
    options: (patch = {}) => send({ type: 'options', ...patch }),
    /**
     * handler({ autostart, topmost }) for every options message of the shell, answers and
     * unasked changes alike. Returns the function that unsubscribes. A shell older than the page
     * never sends one.
     */
    onOptions(handler) {
      if (!inShell || typeof webview.addEventListener !== 'function') return () => {};
      const listener = (event) => {
        const m = event?.data;
        if (m?.type === 'options' && typeof m.autostart === 'boolean' && typeof m.topmost === 'boolean') {
          handler({ autostart: m.autostart, topmost: m.topmost });
        }
      };
      webview.addEventListener('message', listener);
      return () => webview.removeEventListener('message', listener);
    },
  };
}
