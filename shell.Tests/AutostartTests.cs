using AgentTower;

namespace AgentTower.Tests;

public class AutostartTests
{
    // Touches the real registry, under a value name that is not André's and an exe path that does not exist.
    [Fact]
    public void Set_and_IsEnabled_round_trip_under_a_test_name()
    {
        const string name = "AgentTower.Tests";
        const string exe = @"C:\agent-tower-tests\does-not-exist.exe";
        try
        {
            Autostart.Set(false, name, exe);
            Assert.False(Autostart.IsEnabled(name, exe));
            Autostart.Set(true, name, exe);
            Assert.True(Autostart.IsEnabled(name, exe));
            Assert.False(Autostart.IsEnabled(name, @"C:\elsewhere\x.exe"));
        }
        finally
        {
            Autostart.Set(false, name, exe);
        }
        Assert.False(Autostart.IsEnabled(name, exe));
    }
}
