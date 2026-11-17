using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using AgentTower.Logic;

namespace AgentTower;

/// <summary>
/// Reaches the daemon in WSL and starts it when it does not answer. The daemon is started
/// through its own script and never stopped by quitting the app.
/// </summary>
public static class DaemonLauncher
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(1) };
    private static readonly TimeSpan PollEvery = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan GiveUpAfter = TimeSpan.FromSeconds(20);

    /// <summary>The command the app runs to start the daemon, as text for the error page.</summary>
    public static string CommandLine(ShellSettings s) => "wsl.exe " + string.Join(' ', Arguments(s, "start-server.sh"));

    /// <summary>True when GET /api/health answers within 1 s and names agent-tower.</summary>
    public static async Task<bool> IsHealthyAsync(ShellSettings s, CancellationToken ct)
    {
        try
        {
            using var response = await Http.GetAsync($"http://127.0.0.1:{s.Port}/api/health", ct);
            if (!response.IsSuccessStatusCode) return false;
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("name", out var name)
                && name.ValueKind == JsonValueKind.String
                && name.GetString() == "agent-tower";
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            ct.ThrowIfCancellationRequested();
            return false;
        }
    }

    /// <summary>Health check; on failure start the daemon and poll for up to 20 s.</summary>
    public static async Task<bool> EnsureAsync(ShellSettings s, CancellationToken ct)
    {
        if (await IsHealthyAsync(s, ct)) return true;
        using var started = Run(s, "start-server.sh");
        // By the clock, not by the number of tries: a try against a silent port takes its full second.
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < GiveUpAfter)
        {
            await Task.Delay(PollEvery, ct);
            if (await IsHealthyAsync(s, ct)) return true;
        }
        return false;
    }

    /// <summary>Stops the daemon through its script, then starts it again.</summary>
    public static async Task<bool> RestartAsync(ShellSettings s, CancellationToken ct)
    {
        using (var stop = Run(s, "stop-server.sh"))
        {
            if (stop is not null)
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
                limit.CancelAfter(TimeSpan.FromSeconds(15));
                try
                {
                    await stop.WaitForExitAsync(limit.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    // the script took too long; the health check below decides
                }
            }
        }
        return await EnsureAsync(s, ct);
    }

    // The port goes along, so the daemon listens where this app looks for it.
    private static string[] Arguments(ShellSettings s, string script) =>
        ["-d", s.Distro, "-e", "env", $"TOWER_PORT={s.Port}", $"{s.RepoPath.TrimEnd('/')}/scripts/{script}"];

    private static Process? Run(ShellSettings s, string script)
    {
        var info = new ProcessStartInfo("wsl.exe") { CreateNoWindow = true, UseShellExecute = false };
        foreach (var argument in Arguments(s, script)) info.ArgumentList.Add(argument);
        try
        {
            return Process.Start(info);
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException)
        {
            return null; // no wsl.exe: the health poll runs out and the error page shows the command
        }
    }
}
