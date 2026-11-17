using System.IO;
using System.Security;
using AgentTower.Logic;
using Microsoft.Win32;

namespace AgentTower;

/// <summary>
/// "Start with Windows" through the per-user Run key (no Startup shortcut, no admin rights).
/// The decision itself lives in <see cref="AutostartLogic"/>; this class only reads and writes the registry.
/// </summary>
public static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    /// <summary>What the registry says right now; false when it cannot be read.</summary>
    public static bool IsEnabled(string name = "AgentTower", string? exePath = null)
    {
        exePath ??= Environment.ProcessPath;
        if (exePath is null) return false;
        try
        {
            using var run = Registry.CurrentUser.OpenSubKey(RunKey);
            // Anything that is not a string or not a byte[] counts as "no value" / "no flag":
            // one entry on a real machine holds an empty REG_SZ under StartupApproved.
            var runValue = run?.GetValue(name) as string;
            using var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey);
            var flag = approved?.GetValue(name) as byte[];
            return AutostartLogic.Decide(runValue, exePath, flag);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or SecurityException or IOException)
        {
            return false;
        }
    }

    /// <summary>
    /// On: writes the Run value and removes Windows' "disabled" flag, so the entry counts again.
    /// Off: removes both. A registry failure leaves things as they were; ask <see cref="IsEnabled"/> for the truth.
    /// </summary>
    public static void Set(bool on, string name = "AgentTower", string? exePath = null)
    {
        exePath ??= Environment.ProcessPath;
        try
        {
            if (on)
            {
                if (exePath is null) return;
                using var run = Registry.CurrentUser.CreateSubKey(RunKey);
                run.SetValue(name, AutostartLogic.RunValue(exePath), RegistryValueKind.String);
            }
            else
            {
                using var run = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
                run?.DeleteValue(name, throwOnMissingValue: false);
            }
            using var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey, writable: true);
            approved?.DeleteValue(name, throwOnMissingValue: false);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or SecurityException or IOException)
        {
            // Nothing to do: the caller reports what IsEnabled reads.
        }
    }
}
