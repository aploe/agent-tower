using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace AgentTower;

/// <summary>
/// The icon in the notification area. Two variants, drawn at start: the figure's head in the
/// widget's lime, and the same with a red badge while at least one session asks.
/// </summary>
public sealed class Tray : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly ToolStripMenuItem _topmost;
    private bool _settingFromCode; // a check mark set from code must not call back into the window
    private readonly Icon _normal = Draw(attention: false);
    private readonly Icon _attention = Draw(attention: true);

    public Tray(Action toggle, bool topmostOn, Action<bool> setTopmost, Action restartDaemon, Action quit)
    {
        _topmost = new ToolStripMenuItem("Immer im Vordergrund") { Checked = topmostOn, CheckOnClick = true };
        _topmost.CheckedChanged += (_, _) =>
        {
            if (!_settingFromCode) setTopmost(_topmost.Checked);
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add("Anzeigen/Verbergen", null, (_, _) => toggle());
        menu.Items.Add(_topmost);
        menu.Items.Add("Dienst neu starten", null, (_, _) => restartDaemon());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Beenden", null, (_, _) => quit());

        _icon = new NotifyIcon { Icon = _normal, Text = "Agent Tower", ContextMenuStrip = menu, Visible = true };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) toggle();
        };
    }

    /// <summary>Sets the check mark without telling the window (it asked for the change itself).</summary>
    public void SetTopmost(bool on)
    {
        _settingFromCode = true;
        try { _topmost.Checked = on; }
        finally { _settingFromCode = false; }
    }

    public void SetAttention(int count)
    {
        _icon.Icon = count > 0 ? _attention : _normal;
        _icon.Text = count > 0 ? $"Agent Tower · {count} {(count == 1 ? "fragt" : "fragen")}" : "Agent Tower";
    }

    public void Dispose()
    {
        _icon.Visible = false; // otherwise the icon stays until the mouse passes over it
        _icon.Dispose();
    }

    /// <summary>The figure's head (antenna, two eyes, a smile) in the widget's lime.</summary>
    private static Icon Draw(bool attention)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var body = new SolidBrush(Color.FromArgb(0xD4, 0xF5, 0x3C));
            using var eye = new SolidBrush(Color.FromArgb(0x17, 0x17, 0x19));
            using var mouth = new Pen(Color.FromArgb(0x17, 0x17, 0x19), 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round };

            g.FillRectangle(body, 15, 3, 2, 6);
            g.FillEllipse(body, 13, 0, 6, 6);
            using (var head = Rounded(new RectangleF(3, 7, 26, 23), 9)) g.FillPath(body, head);
            g.FillEllipse(eye, 9, 15, 5, 5);
            g.FillEllipse(eye, 18, 15, 5, 5);
            g.DrawArc(mouth, 12, 19, 8, 6, 20, 140);

            if (attention)
            {
                using var ring = new SolidBrush(Color.FromArgb(0x17, 0x17, 0x19));
                using var dot = new SolidBrush(Color.FromArgb(0xFF, 0x5A, 0x4D)); // lime on lime would not show
                g.FillEllipse(ring, 17, 0, 15, 15);
                g.FillEllipse(dot, 19, 2, 11, 11);
            }
        }
        return Icon.FromHandle(bitmap.GetHicon()); // two handles for the life of the process
    }

    private static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
