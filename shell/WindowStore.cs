using System.IO;
using System.Text.Json;

namespace AgentTower;

/// <summary>
/// Where the window was left: %LOCALAPPDATA%\AgentTower\window.json as { "left", "top", "height" }
/// in device-independent pixels. The height belongs to it because the window grows upwards
/// from a bottom corner: its bottom edge is top + height.
/// </summary>
public sealed class WindowStore(string path)
{
    public readonly record struct Spot(double Left, double Top, double Height);

    public Spot? Load()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (Number(root, "left") is not { } left || Number(root, "top") is not { } top) return null;
            var height = Number(root, "height") is { } h && h > 0 ? h : 0;
            return new Spot(left, top, height);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    public void Save(Spot spot)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(new { left = spot.Left, top = spot.Top, height = spot.Height }));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Not being able to remember the position is no reason to disturb the user.
        }
    }

    private static double? Number(JsonElement root, string key) =>
        root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetDouble(out var d) && double.IsFinite(d)
            ? d
            : null;
}
