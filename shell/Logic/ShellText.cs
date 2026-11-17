namespace AgentTower.Logic;

/// <summary>
/// The shell's own texts (tray menu, tray tooltip, the pages shown while the daemon's page
/// cannot be). Same languages as the page; the page tells the shell which one it shows.
/// </summary>
public sealed record ShellText(
    string Code,
    string ShowHide,
    string Topmost,
    string RestartDaemon,
    string Quit,
    string AskingOne,
    string AskingMany,
    string NoAnswer,
    string TryAgain,
    string Starting,
    string WebViewFailed)
{
    public static ShellText English { get; } = new(
        "en", "Show/Hide", "Always on top", "Restart daemon", "Quit",
        "{0} asking", "{0} asking",
        "The daemon in WSL does not answer.", "Try again", "Starting the daemon in WSL …",
        "The Microsoft Edge WebView2 runtime could not be started.");

    public static ShellText German { get; } = new(
        "de", "Anzeigen/Verbergen", "Immer im Vordergrund", "Dienst neu starten", "Beenden",
        "{0} fragt", "{0} fragen",
        "Der Dienst in WSL antwortet nicht.", "Erneut versuchen", "Der Dienst in WSL wird gestartet …",
        "Die WebView2-Laufzeit von Microsoft Edge ließ sich nicht starten.");

    public static bool IsKnown(string? code) => code is "en" or "de";

    /// <summary>An unknown or missing code gives English.</summary>
    public static ShellText For(string? code) => code == "de" ? German : English;

    public string Asking(int count) => string.Format(count == 1 ? AskingOne : AskingMany, count);
}
