using System.Text.Json;

namespace AgentTower.Logic;

/// <summary>
/// What the page may ask of the shell (window.chrome.webview.postMessage). The list is closed:
/// anything else, and any value out of range, parses to null and is ignored.
/// </summary>
public abstract record BridgeMessage
{
    private BridgeMessage() { }

    /// <summary>The panel's height in device-independent pixels.</summary>
    public sealed record Resize(double Height) : BridgeMessage;

    /// <summary>The header was pressed: start moving the window.</summary>
    public sealed record Drag : BridgeMessage;

    /// <summary>The header's X: hide the window, keep the tray icon.</summary>
    public sealed record Hide : BridgeMessage;

    /// <summary>How many sessions ask right now.</summary>
    public sealed record Attention(int Count) : BridgeMessage;

    /// <summary>The error page's button: try to reach the daemon again.</summary>
    public sealed record Retry : BridgeMessage;

    /// <summary>The language the page shows; the shell uses it for its own texts.</summary>
    public sealed record Language(string Code) : BridgeMessage;

    /// <summary>The settings panel changed an option; a field that is null was not sent.</summary>
    public sealed record Options(bool? Autostart, bool? Topmost) : BridgeMessage;

    public static BridgeMessage? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;
            switch (type.GetString())
            {
                case "resize":
                    return root.TryGetProperty("height", out var h) && h.ValueKind == JsonValueKind.Number
                        && h.TryGetDouble(out var height) && double.IsFinite(height) && height is >= 40 and <= 4000
                        ? new Resize(height)
                        : null;
                case "attention":
                    return root.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number
                        && c.TryGetInt32(out var count) && count >= 0
                        ? new Attention(count)
                        : null;
                case "options":
                    if (!TryReadBool(root, "autostart", out var autostart)
                        || !TryReadBool(root, "topmost", out var topmost)) return null;
                    return new Options(autostart, topmost);
                case "language":
                    return root.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String
                        && ShellText.IsKnown(code.GetString())
                        ? new Language(code.GetString()!)
                        : null;
                case "drag": return new Drag();
                case "hide": return new Hide();
                case "retry": return new Retry();
                default: return null;
            }
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Absent is fine (null); present must be a JSON boolean.</summary>
    private static bool TryReadBool(JsonElement root, string key, out bool? value)
    {
        value = null;
        if (!root.TryGetProperty(key, out var v)) return true;
        if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        value = v.GetBoolean();
        return true;
    }
}
