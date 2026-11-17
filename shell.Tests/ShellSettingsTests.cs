using System.IO;
using AgentTower.Logic;

namespace AgentTower.Tests;

public class ShellSettingsTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("agent-tower-tests-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Write(string json)
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, json);
        return path;
    }

    [Fact]
    public void Defaults_are_the_documented_ones() =>
        Assert.Equal(new ShellSettings("Ubuntu", "/home/user/agent-tower", 4188, true), ShellSettings.Defaults);

    [Fact]
    public void Settings_missing_file_gives_defaults() =>
        Assert.Equal(ShellSettings.Defaults, ShellSettings.Load(Path.Combine(_dir, "nope.json")));

    [Fact]
    public void Settings_partial_file_merges_per_key() =>
        Assert.Equal(ShellSettings.Defaults with { Port = 4200 }, ShellSettings.Load(Write("{\"port\":4200}")));

    [Fact]
    public void Settings_full_file_is_read() =>
        Assert.Equal(new ShellSettings("Debian", "/srv/tower", 5000, true),
            ShellSettings.Load(Write("{\"distro\":\"Debian\",\"repoPath\":\"/srv/tower\",\"port\":5000}")));

    [Fact]
    public void Settings_invalid_json_gives_defaults() =>
        Assert.Equal(ShellSettings.Defaults, ShellSettings.Load(Write("{ not json")));

    [Theory]
    [InlineData("{\"port\":0}")]
    [InlineData("{\"port\":70000}")]
    [InlineData("{\"port\":\"4200\"}")]
    [InlineData("{\"port\":4188.5}")]
    [InlineData("{\"distro\":\"\"}")]
    [InlineData("{\"distro\":5}")]
    [InlineData("{\"repoPath\":\"relative/path\"}")]
    [InlineData("{\"language\":\"fr\"}")]
    [InlineData("{\"language\":1}")]
    [InlineData("[1,2]")]
    public void Settings_wrong_values_fall_back_per_key(string json) =>
        Assert.Equal(ShellSettings.Defaults, ShellSettings.Load(Write(json)));

    [Fact]
    public void Topmost_defaults_to_true_and_is_read()
    {
        Assert.True(ShellSettings.Defaults.Topmost);
        Assert.False(ShellSettings.Load(Write("{\"topmost\":false}")).Topmost);
        Assert.True(ShellSettings.Load(Write("{\"topmost\":\"no\"}")).Topmost);
    }

    [Fact]
    public void Language_defaults_to_English_and_is_read()
    {
        Assert.Equal("en", ShellSettings.Defaults.Language);
        Assert.Equal("de", ShellSettings.Load(Write("{\"language\":\"de\"}")).Language);
    }

    [Fact]
    public void Save_then_Load_gives_the_same_settings()
    {
        var s = new ShellSettings("Debian", "/srv/tower", 5000, false, "de");
        var path = Path.Combine(_dir, "sub", "settings.json");
        s.Save(path);
        Assert.Equal(s, ShellSettings.Load(path));
    }
}
