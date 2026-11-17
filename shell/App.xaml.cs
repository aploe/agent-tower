using System.IO;
using System.Windows;
using AgentTower.Logic;

namespace AgentTower;

public partial class App : Application
{
    private Mutex? _single;
    private Tray? _tray;
    private MainWindow? _window;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // One instance only: a second start leaves at once.
        _single = new Mutex(initiallyOwned: true, "AgentTower", out var first);
        if (!first)
        {
            _single.Dispose();
            _single = null;
            Shutdown();
            return;
        }

        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentTower");
        Directory.CreateDirectory(dataDir);
        var settings = ShellSettings.Load(Path.Combine(dataDir, "settings.json"));

        _window = new MainWindow(settings, dataDir);
        _tray = new Tray(
            toggle: _window.Toggle,
            topmostOn: settings.Topmost,
            setTopmost: _window.SetTopmost,
            restartDaemon: _window.RestartDaemon,
            quit: Quit);
        _window.AttentionChanged += _tray.SetAttention;
        _window.TopmostChanged += _tray.SetTopmost;
        _window.Show();
    }

    /// <summary>Ends the app. The daemon in WSL keeps running.</summary>
    private void Quit()
    {
        _window?.AllowClose();
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _tray?.Dispose();
        if (_single is not null)
        {
            _single.ReleaseMutex();
            _single.Dispose();
        }
        base.OnExit(e);
    }
}
