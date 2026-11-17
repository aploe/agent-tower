namespace AgentTower.Logic;

/// <summary>
/// Whether the app's autostart entry counts as enabled. Touches no registry: the caller reads
/// the Run value and the StartupApproved bytes and hands them in.
/// </summary>
public static class AutostartLogic
{
    /// <summary>The Run value to write: the exe path in double quotes (paths may hold spaces).</summary>
    public static string RunValue(string exePath) => "\"" + exePath + "\"";

    /// <summary>
    /// On when the Run value points at this exe (quotes and case ignored) and Windows has not
    /// disabled it. StartupApproved\Run: first byte even (2, 6) = enabled, odd (3, 7) = disabled
    /// in Task Manager or Settings; no entry or no bytes = enabled.
    /// </summary>
    public static bool Decide(string? runValue, string exePath, byte[]? approved)
    {
        if (runValue is null) return false;
        if (!string.Equals(runValue.Trim('"', ' '), exePath, StringComparison.OrdinalIgnoreCase)) return false;
        return approved is null || approved.Length == 0 || approved[0] % 2 == 0;
    }
}
