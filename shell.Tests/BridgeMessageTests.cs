using AgentTower.Logic;

namespace AgentTower.Tests;

public class BridgeMessageTests
{
    [Fact]
    public void Parse_reads_the_message_types()
    {
        Assert.Equal(new BridgeMessage.Resize(412.5), BridgeMessage.Parse("{\"type\":\"resize\",\"height\":412.5}"));
        Assert.Equal(new BridgeMessage.Attention(2), BridgeMessage.Parse("{\"type\":\"attention\",\"count\":2}"));
        Assert.IsType<BridgeMessage.Drag>(BridgeMessage.Parse("{\"type\":\"drag\"}"));
        Assert.IsType<BridgeMessage.Hide>(BridgeMessage.Parse("{\"type\":\"hide\"}"));
        Assert.IsType<BridgeMessage.Retry>(BridgeMessage.Parse("{\"type\":\"retry\"}"));
    }

    [Fact]
    public void Parse_reads_options()
    {
        Assert.Equal(new BridgeMessage.Options(null, null), BridgeMessage.Parse("{\"type\":\"options\"}"));
        Assert.Equal(new BridgeMessage.Options(true, null), BridgeMessage.Parse("{\"type\":\"options\",\"autostart\":true}"));
        Assert.Equal(new BridgeMessage.Options(false, true), BridgeMessage.Parse("{\"type\":\"options\",\"autostart\":false,\"topmost\":true}"));
    }

    [Theory]
    [InlineData("nonsense")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("\"resize\"")]
    [InlineData("{\"type\":\"resize\"}")]
    [InlineData("{\"type\":\"resize\",\"height\":\"x\"}")]
    [InlineData("{\"type\":\"resize\",\"height\":5}")]
    [InlineData("{\"type\":\"resize\",\"height\":4001}")]
    [InlineData("{\"type\":\"resize\",\"height\":1e999}")]
    [InlineData("{\"type\":\"attention\",\"count\":-1}")]
    [InlineData("{\"type\":\"attention\",\"count\":1.5}")]
    [InlineData("{\"type\":\"attention\"}")]
    [InlineData("{\"type\":\"exec\",\"cmd\":\"calc\"}")]
    [InlineData("{\"type\":7}")]
    [InlineData("{\"type\":\"options\",\"autostart\":\"yes\"}")]
    [InlineData("{\"type\":\"options\",\"topmost\":1}")]
    [InlineData("{\"type\":\"options\",\"autostart\":null}")]
    public void Parse_rejects(string json) => Assert.Null(BridgeMessage.Parse(json));
}
