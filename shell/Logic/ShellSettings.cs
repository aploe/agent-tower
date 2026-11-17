using System.IO;
using System.Text.Json;

namespace AgentTower.Logic;

/// <summary>
/// %LOCALAPPDATA%\AgentTower\settings.json. A missing file, a missing key, a wrong value and
/// invalid JSON fall back to the defaults, key by key: the app must start in any case.
/// </summary>
public sealed record ShellSettings(string Distro, string RepoPath, int Port, bool Topmost, string Language = "en")
{
    // RepoPath is a placeholder: scripts/build-shell.sh writes the real path into settings.json.
    public static ShellSettings Defaults { get; } =
        new("Ubuntu", "/home/user/agent-tower", 4188, true);

    public static ShellSettings Load(string path)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Defaults;
            return new ShellSettings(
                ReadText(root, "distro", s => s.Length > 0) ?? Defaults.Distro,
                // The path is handed to wsl.exe as the program to run: absolute Linux paths only.
                ReadText(root, "repoPath", s => s.StartsWith('/')) ?? Defaults.RepoPath,
                ReadPort(root) ?? Defaults.Port,
                ReadBool(root, "topmost") ?? Defaults.Topmost,
                ReadText(root, "language", ShellText.IsKnown) ?? Defaults.Language);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return Defaults;
        }
    }

    /// <summary>Writes the five keys Load reads back; creates the folder if it is missing.</summary>
    public void Save(string path)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(path, JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["distro"] = Distro,
            ["repoPath"] = RepoPath,
            ["port"] = Port,
            ["topmost"] = Topmost,
            ["language"] = Language,
        }, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static bool? ReadBool(JsonElement root, string key) =>
        root.TryGetProperty(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean()
            : null;

    private static string? ReadText(JsonElement root, string key, Func<string, bool> valid) =>
        root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { } s && valid(s)
            ? s
            : null;

    private static int? ReadPort(JsonElement root) =>
        root.TryGetProperty("port", out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetInt32(out var port) && port is >= 1 and <= 65535
            ? port
            : null;
}
