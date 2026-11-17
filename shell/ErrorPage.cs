using System.Net;
using AgentTower.Logic;

namespace AgentTower;

/// <summary>The two pages the app shows by itself, while the daemon's page cannot be shown.</summary>
public static class ErrorPage
{
    private const string Style = """
        html { scrollbar-width: none; }
        body { margin: 0; padding: 14px 16px 16px; background: #171719; color: #f4f4f6;
               font: 13px/1.4 'Segoe UI', system-ui, sans-serif; user-select: none; cursor: default; }
        h1 { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
        p { margin: 0 0 10px; color: #b4b4ba; }
        code { display: block; margin: 0 0 12px; padding: 8px 10px; border-radius: 6px; background: #101012;
               color: #d4f53c; font: 12px Consolas, monospace; word-break: break-all; user-select: text; cursor: text; }
        button { height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: #3f3f44;
                 color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
        button:hover { background: #4b4b51; }
        """;

    // Reports its height like the daemon's page does, and lets the window be moved.
    private const string Script = """
        const post = (message) => window.chrome?.webview?.postMessage(message);
        post({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) });
        document.addEventListener('pointerdown', (e) => {
          if (e.button === 0 && !e.target.closest('button, code')) post({ type: 'drag' });
        });
        document.getElementById('retry')?.addEventListener('click', () => post({ type: 'retry' }));
        """;

    /// <summary>Shown after the daemon did not answer for 20 s.</summary>
    public static string Html(string command, ShellText text) => Page(text, $"""
        <h1>Agent Tower</h1>
        <p>{WebUtility.HtmlEncode(text.NoAnswer)}</p>
        <code>{WebUtility.HtmlEncode(command)}</code>
        <button id="retry" type="button">{WebUtility.HtmlEncode(text.TryAgain)}</button>
        """);

    /// <summary>Shown while the daemon is being started.</summary>
    public static string Starting(ShellText text) => Page(text, $"""
        <h1>Agent Tower</h1>
        <p style="margin: 0">{WebUtility.HtmlEncode(text.Starting)}</p>
        """);

    private static string Page(ShellText text, string body) => $"""
        <!doctype html>
        <html lang="{text.Code}">
        <head><meta charset="utf-8"><title>Agent Tower</title><style>{Style}</style></head>
        <body>
        {body}
        <script>{Script}</script>
        </body>
        </html>
        """;
}
