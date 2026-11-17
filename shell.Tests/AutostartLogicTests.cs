using AgentTower.Logic;

namespace AgentTower.Tests;

public class AutostartLogicTests
{
    private const string Exe = @"C:\Users\a\AppData\Local\AgentTower\app\AgentTower.exe";

    [Fact]
    public void RunValue_quotes_the_path() => Assert.Equal("\"" + Exe + "\"", AutostartLogic.RunValue(Exe));

    [Fact]
    public void Decide_on_for_this_exe_quoted_or_not_any_case()
    {
        Assert.True(AutostartLogic.Decide("\"" + Exe + "\"", Exe, null));
        Assert.True(AutostartLogic.Decide(Exe.ToUpperInvariant(), Exe, null));
        Assert.True(AutostartLogic.Decide(AutostartLogic.RunValue(Exe), Exe, new byte[] { 2, 0, 0, 0 }));
    }

    [Fact]
    public void Decide_off_without_value_for_another_path_or_when_Windows_disabled_it()
    {
        Assert.False(AutostartLogic.Decide(null, Exe, null));
        Assert.False(AutostartLogic.Decide("\"C:\\old\\AgentTower.exe\"", Exe, null));
        Assert.False(AutostartLogic.Decide(AutostartLogic.RunValue(Exe), Exe, new byte[] { 3, 0, 0, 0 }));
        Assert.False(AutostartLogic.Decide(AutostartLogic.RunValue(Exe), Exe, new byte[] { 7 }));
        Assert.True(AutostartLogic.Decide(AutostartLogic.RunValue(Exe), Exe, new byte[0]));
    }
}
