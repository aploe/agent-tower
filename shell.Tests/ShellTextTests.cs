using AgentTower.Logic;

namespace AgentTower.Tests;

public class ShellTextTests
{
    [Fact]
    public void For_picks_the_language_and_falls_back_to_English()
    {
        Assert.Same(ShellText.German, ShellText.For("de"));
        Assert.Same(ShellText.English, ShellText.For("en"));
        Assert.Same(ShellText.English, ShellText.For("fr"));
        Assert.Same(ShellText.English, ShellText.For(null));
    }

    [Fact]
    public void Asking_counts_in_both_languages()
    {
        Assert.Equal("1 asking", ShellText.English.Asking(1));
        Assert.Equal("3 asking", ShellText.English.Asking(3));
        Assert.Equal("1 fragt", ShellText.German.Asking(1));
        Assert.Equal("3 fragen", ShellText.German.Asking(3));
    }

    [Fact]
    public void The_pages_carry_the_texts_and_the_language()
    {
        var page = ErrorPage.Html("wsl.exe -d Ubuntu", ShellText.German);
        Assert.Contains("<html lang=\"de\">", page);
        Assert.Contains("Der Dienst in WSL antwortet nicht.", page);
        Assert.Contains("Erneut versuchen", page);
        Assert.Contains("Starting the daemon in WSL", ErrorPage.Starting(ShellText.English));
    }
}
