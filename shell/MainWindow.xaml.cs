using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using AgentTower.Logic;
using Microsoft.Web.WebView2.Core;
using Screen = System.Windows.Forms.Screen;

namespace AgentTower;

/// <summary>
/// The widget window: no frame, on top, 400 wide, as tall as the page says. Its only content
/// is a WebView2 on the daemon's page (design, section 9).
/// </summary>
public partial class MainWindow : Window
{
    private const double PanelWidth = 400;
    private const double Inset = 1; // the frame around the page, see MainWindow.xaml
    private const double HeaderHeight = 52 + 2 * Inset; // the collapsed panel (44 header + 8 padding) in its frame

    private ShellSettings _settings; // read again before every connect, so a corrected file counts on retry
    private readonly string _dataDir;
    private readonly WindowStore _store;
    private IntPtr _hwnd;
    private bool _allowClose;
    private bool _local; // one of the app's own pages is shown, not the daemon's
    private int _localNavigations; // navigations to such pages that were asked for and have not started yet
    private bool _connecting;

    /// <summary>How many sessions ask right now, as the page reports it.</summary>
    public event Action<int>? AttentionChanged;

    /// <summary>"Always on top" changed, from the page or the tray (so the tray's check mark can follow).</summary>
    public event Action<bool>? TopmostChanged;

    private string Origin => $"http://127.0.0.1:{_settings.Port}";

    // The window keeps one horizontal edge in place when its height changes: the bottom edge
    // when it sits in the lower half of its screen (it grows upwards), the top edge otherwise.
    // Decided at start and after every move, not per resize, so it cannot flip while growing.
    private bool _anchorBottom;
    private double _edge;

    public MainWindow(ShellSettings settings, string dataDir)
    {
        _settings = settings;
        _dataDir = dataDir;
        _store = new WindowStore(Path.Combine(dataDir, "window.json"));
        InitializeComponent();
        Topmost = settings.Topmost; // the XAML says True; the stored value wins
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x17, 0x17, 0x19); // the page's --panel

        var areas = WorkAreas();
        var stored = _store.Load();
        var start = stored is { } s && Placement.IsReachable(new Rect(s.Left, s.Top, PanelWidth, Math.Max(s.Height, HeaderHeight)), areas)
            ? new Rect(s.Left, s.Top, PanelWidth, Math.Max(s.Height, HeaderHeight))
            : Placement.DefaultRect(SystemParameters.WorkArea, PanelWidth, HeaderHeight);
        Anchor(start, areas);
        Left = Placement.ClampLeft(start.Left, PanelWidth, AreaOf(start, areas)); // fully on its screen
        Width = PanelWidth;
        Height = HeaderHeight; // until the page reports its own
        Top = _anchorBottom ? _edge - HeaderHeight : _edge;

        SourceInitialized += OnSourceInitialized;
        Loaded += async (_, _) => await StartWebViewAsync();
        Closing += (_, e) =>
        {
            // Alt+F4 hides like the header's X; only "Quit" in the tray menu ends the app.
            if (_allowClose) return;
            e.Cancel = true;
            Hide();
        };
    }

    public void Toggle()
    {
        if (IsVisible) Hide();
        else Show();
    }

    public void AllowClose() => _allowClose = true;

    /// <summary>
    /// Window, settings.json, tray (via the event) and page, in one place. The file and the event
    /// are touched only on a real change; the page always gets the state back.
    /// </summary>
    public void SetTopmost(bool on)
    {
        if (Topmost != on)
        {
            Topmost = on;
            try
            {
                _settings = _settings with { Topmost = on };
                _settings.Save(SettingsPath);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // The window already follows; only the next start would forget it.
            }
            TopmostChanged?.Invoke(on);
        }
        PostOptions();
    }

    private string SettingsPath => Path.Combine(_dataDir, "settings.json");

    /// <summary>Tells the page the real state, not the one it asked for.</summary>
    private void PostOptions()
    {
        if (Web.CoreWebView2 is null) return;
        var json = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["type"] = "options",
            ["autostart"] = Autostart.IsEnabled(),
            ["topmost"] = Topmost,
        });
        Web.CoreWebView2.PostWebMessageAsJson(json);
    }

    /// <summary>Tray menu: stop and start the daemon, then show its page again.</summary>
    public async void RestartDaemon()
    {
        if (Web.CoreWebView2 is null) return;
        await ConnectAsync(restart: true);
    }

    // ---------- placement ----------

    /// <summary>All work areas in device-independent pixels of the system DPI.</summary>
    private static List<Rect> WorkAreas()
    {
        var primary = Screen.PrimaryScreen;
        var scale = primary is null || primary.Bounds.Width == 0
            ? 1.0
            : SystemParameters.PrimaryScreenWidth / primary.Bounds.Width;
        return Screen.AllScreens
            .Select(s => s.WorkingArea)
            .Select(a => new Rect(a.Left * scale, a.Top * scale, a.Width * scale, a.Height * scale))
            .ToList();
    }

    /// <summary>The work area the rectangle mostly lies on; the primary one when it lies on none.</summary>
    private static Rect AreaOf(Rect window, List<Rect> areas)
    {
        var best = SystemParameters.WorkArea;
        double bestSize = 0;
        foreach (var area in areas)
        {
            var hit = Rect.Intersect(window, area);
            var size = hit.IsEmpty ? 0 : hit.Width * hit.Height;
            if (size > bestSize)
            {
                bestSize = size;
                best = area;
            }
        }
        return best;
    }

    private void Anchor(Rect window, List<Rect> areas)
    {
        var area = AreaOf(window, areas);
        _anchorBottom = window.Top + window.Height / 2 > area.Top + area.Height / 2;
        _edge = _anchorBottom ? window.Bottom : window.Top;
    }

    private void ApplyHeight(double requested)
    {
        var area = AreaOf(new Rect(Left, Top, Width, Height), WorkAreas());
        var height = Placement.ClampHeight(requested + 2 * Inset, HeaderHeight, area);
        var top = _anchorBottom ? _edge - height : _edge;
        top = Math.Max(area.Top, Math.Min(top, area.Bottom - height)); // stay on the screen; the edge itself is kept
        if (Math.Abs(height - Height) < 0.5 && Math.Abs(top - Top) < 0.5) return;

        // One call for position and size: two separate steps would show for a frame.
        var dpi = VisualTreeHelper.GetDpi(this);
        SetWindowPos(_hwnd, IntPtr.Zero,
            (int)Math.Round(Left * dpi.DpiScaleX), (int)Math.Round(top * dpi.DpiScaleY),
            (int)Math.Round(Width * dpi.DpiScaleX), (int)Math.Round(height * dpi.DpiScaleY),
            SWP_NOZORDER | SWP_NOACTIVATE);
        // A taller window can reach the top or the bottom of its screen.
        ShowDocked(Placement.Docked(new Rect(Left, top, Width, height), WorkAreas()));
    }

    // ---------- the look of docked sides ----------

    private Sides? _shownDocked;

    /// <summary>
    /// A side that lies on a screen edge loses its border line (it takes the window's colour),
    /// and a docked window has square corners, like a window Windows itself has snapped. A
    /// floating window keeps the system's rounded corners and border.
    /// </summary>
    private void ShowDocked(Sides docked)
    {
        if (_shownDocked == docked || _hwnd == IntPtr.Zero) return;
        _shownDocked = docked;

        var floating = docked == Sides.None;
        var corners = floating ? DWMWCP_ROUND : DWMWCP_DONOTROUND;
        var border = floating ? DWMWA_COLOR_DEFAULT : DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(_hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corners, sizeof(int)); // both ignored before Windows 11
        DwmSetWindowAttribute(_hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));

        double Line(Sides side) => floating || docked.HasFlag(side) ? 0 : Inset;
        var lines = new Thickness(Line(Sides.Left), Line(Sides.Top), Line(Sides.Right), Line(Sides.Bottom));
        Frame.BorderThickness = lines;
        // Line and padding always add up to the inset, so the page never changes its size.
        Frame.Padding = new Thickness(Inset - lines.Left, Inset - lines.Top, Inset - lines.Right, Inset - lines.Bottom);
    }

    // ---------- window ----------

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        ShowDocked(Placement.Docked(new Rect(Left, Top, Width, Height), WorkAreas()));
        HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        switch (msg)
        {
            case WM_ENTERSIZEMOVE:
                BeginMove();
                break;
            case WM_MOVING when _move is not null:
                SnapWhileMoving(lParam);
                handled = true;
                return new IntPtr(1);
            case WM_EXITSIZEMOVE:
            {
                _move = null;
                // A move ended: this is where the window lives now.
                var here = new Rect(Left, Top, Width, Height);
                var areas = WorkAreas();
                Anchor(here, areas);
                ShowDocked(Placement.Docked(here, areas));
                _store.Save(new WindowStore.Spot(here.Left, here.Top, here.Height));
                break;
            }
        }
        return IntPtr.Zero;
    }

    // ---------- snapping to screen edges while dragged ----------

    private const double SnapDistance = 12; // device-independent pixels

    /// <summary>What a running move needs: where the pointer holds the window, and the edges to snap to.</summary>
    private sealed record Move(int GrabX, int GrabY, List<Rect> Areas, double Distance);

    private Move? _move;

    private void BeginMove()
    {
        if (!GetCursorPos(out var pointer) || !GetWindowRect(_hwnd, out var rect)) return;
        // Work areas (the taskbar left out) of every monitor, in the pixels WM_MOVING speaks.
        var areas = Screen.AllScreens
            .Select(s => s.WorkingArea)
            .Select(a => new Rect(a.Left, a.Top, a.Width, a.Height))
            .ToList();
        _move = new Move(pointer.X - rect.Left, pointer.Y - rect.Top, areas,
            SnapDistance * VisualTreeHelper.GetDpi(this).DpiScaleX);
    }

    /// <summary>
    /// The window's place is taken from the pointer, not from the rectangle Windows proposes:
    /// that one continues from the last (snapped) position, and the window would stick to an
    /// edge or drift away from the pointer.
    /// </summary>
    private void SnapWhileMoving(IntPtr lParam)
    {
        if (_move is not { } move || !GetCursorPos(out var pointer)) return;
        var proposed = Marshal.PtrToStructure<RECT>(lParam);
        var width = proposed.Right - proposed.Left;
        var height = proposed.Bottom - proposed.Top;
        var snapped = Placement.Snap(
            new Rect(pointer.X - move.GrabX, pointer.Y - move.GrabY, width, height), move.Areas, move.Distance);
        var left = (int)Math.Round(snapped.Left);
        var top = (int)Math.Round(snapped.Top);
        Marshal.StructureToPtr(new RECT { Left = left, Top = top, Right = left + width, Bottom = top + height }, lParam, false);
        ShowDocked(Placement.Docked(new Rect(left, top, width, height), move.Areas)); // the look follows while dragging
    }

    // ---------- page ----------

    private async Task StartWebViewAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "WebView2"));
            await Web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception e)
        {
            MessageBox.Show(
                "The Microsoft Edge WebView2 runtime could not be started.\n\n" + e.Message,
                "Agent Tower", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
            return;
        }

        var settings = Web.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.IsStatusBarEnabled = false;
#if !DEBUG
        settings.AreDevToolsEnabled = false;
#endif
        var core = Web.CoreWebView2;
        core.WebMessageReceived += OnWebMessage;
        // Navigation lock: nothing but the daemon's origin and the app's own pages.
        core.NavigationStarting += (_, e) => e.Cancel = !MayNavigate(e.Uri);
        core.FrameNavigationStarting += (_, e) => e.Cancel = !IsDaemonUrl(e.Uri);
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationCompleted += (_, e) =>
        {
            // The daemon went away between the health check and the page load.
            if (!e.IsSuccess && !_local && !_connecting
                && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                ShowLocal(ErrorPage.Html(DaemonLauncher.CommandLine(_settings)));
            }
        };
        await ConnectAsync(restart: false);
    }

    /// <summary>Health check, start of the daemon if needed, then its page or the error page.</summary>
    private async Task ConnectAsync(bool restart)
    {
        if (_connecting) return;
        _connecting = true;
        try
        {
            _settings = ShellSettings.Load(SettingsPath);
            bool ok;
            if (!restart && await DaemonLauncher.IsHealthyAsync(_settings, CancellationToken.None))
            {
                ok = true;
            }
            else
            {
                ShowLocal(ErrorPage.Starting());
                ok = restart
                    ? await DaemonLauncher.RestartAsync(_settings, CancellationToken.None)
                    : await DaemonLauncher.EnsureAsync(_settings, CancellationToken.None);
            }

            if (ok)
            {
                _local = false;
                Web.CoreWebView2.Navigate(Origin + "/");
            }
            else
            {
                ShowLocal(ErrorPage.Html(DaemonLauncher.CommandLine(_settings)));
            }
        }
        finally
        {
            _connecting = false;
        }
    }

    private void ShowLocal(string html)
    {
        _local = true;
        _localNavigations++;
        Web.CoreWebView2.NavigateToString(html);
    }

    private bool IsDaemonUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.GetLeftPart(UriPartial.Authority).Equals(Origin, StringComparison.OrdinalIgnoreCase);

    private bool MayNavigate(string url)
    {
        if (_localNavigations > 0)
        {
            _localNavigations--; // exactly the NavigateToString calls that were asked for
            return true;
        }
        return IsDaemonUrl(url);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!_local && !IsDaemonUrl(e.Source)) return;
        switch (BridgeMessage.Parse(e.WebMessageAsJson))
        {
            case BridgeMessage.Resize resize:
                ApplyHeight(resize.Height);
                break;
            case BridgeMessage.Drag:
                // Hand the pressed mouse button over to Windows as if a title bar had been hit.
                ReleaseCapture();
                SendMessage(_hwnd, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
                break;
            case BridgeMessage.Hide:
                Hide();
                break;
            case BridgeMessage.Attention attention:
                AttentionChanged?.Invoke(attention.Count);
                break;
            case BridgeMessage.Options options when !_local: // only the daemon's page, never the app's own pages
                if (options.Autostart is { } autostart) Autostart.Set(autostart);
                if (options.Topmost is { } topmost) SetTopmost(topmost); // answers itself
                else PostOptions();
                break;
            case BridgeMessage.Retry when _local:
                _ = ConnectAsync(restart: false);
                break;
        }
    }

    // ---------- Win32 ----------

    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int WM_MOVING = 0x0216;
    private const int WM_ENTERSIZEMOVE = 0x0231;
    private const int WM_EXITSIZEMOVE = 0x0232;
    private static readonly IntPtr HTCAPTION = new(2);
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_DONOTROUND = 1;
    private const int DWMWCP_ROUND = 2;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_COLOR_DEFAULT = unchecked((int)0xFFFFFFFF);
    private const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
