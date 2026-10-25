using Archon.EdgeCases;
using Xunit;

namespace Archon.E2E.Tests;

public class ParamsTests
{
    private readonly ApiClient _client = Env.Client();

    [Fact]
    public async Task SerializesAllPathStyles()
    {
        var echo = await _client.Echo.EchoPathStylesAsync(["a", "b"], ["a", "b"], new EchoPathStylesMatrix { X = 1, Y = 2 });
        Assert.Equal("GET", echo.Method);
        Assert.Equal("/echo/path/a,b/.a.b/;x=1;y=2", echo.Path);
        Assert.Equal("", echo.Query);
    }

    [Fact]
    public async Task PercentEncodesReservedCharacters()
    {
        var echo = await _client.Echo.EchoPathStylesAsync(["a/b?c#d e", "日本"], ["x"], new EchoPathStylesMatrix { X = 1, Y = 2 });
        Assert.Equal("/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2", echo.Path);
    }

    [Fact]
    public async Task SerializesAllQueryStyles()
    {
        var echo = await _client.Echo.EchoQueryStylesAsync(
            formExploded: ["a", "b"],
            formFlat: ["a", "b"],
            spaced: ["a", "b"],
            piped: [1, 2],
            filter: new EchoQueryStylesFilter { Status = "active", MinAge = 3 },
            reserved: "a/b?c:d",
            limit: 10);
        Assert.Equal("/echo/query", echo.Path);
        Assert.Equal(
            string.Join('&', [
                "formExploded=a&formExploded=b",
                "formFlat=a,b",
                "spaced=a%20b",
                "piped=1|2",
                "filter[status]=active&filter[minAge]=3",
                "reserved=a/b?c:d",
                "limit=10",
            ]),
            echo.Query);
    }

    [Fact]
    public async Task OmitsUnsetQueryParameters()
    {
        var echo = await _client.Echo.EchoQueryStylesAsync(limit: 1);
        Assert.Equal("limit=1", echo.Query);
    }

    [Fact]
    public async Task SendsHeaderArrayAndCookies()
    {
        var echo = await _client.Echo.EchoHeadersCookiesAsync(["a", "b"], "dark", xTrace: "trace-1", tags: ["x", "y"]);
        Assert.Equal("a,b", echo.Headers["x-request-ids"]);
        Assert.Equal("trace-1", echo.Headers["x-trace"]);
        Assert.Equal("theme=dark; tags=x,y", echo.Headers["cookie"]);
        Assert.Equal(new Dictionary<string, string> { ["theme"] = "dark", ["tags"] = "x,y" }, echo.Cookies);
    }
}
