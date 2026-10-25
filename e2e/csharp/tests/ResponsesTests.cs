using Archon.EdgeCases;
using Xunit;

namespace Archon.E2E.Tests;

public class ResponsesTests
{
    private readonly ApiClient _client = Env.Client();

    [Fact]
    public async Task DecodesTextPlainAsAString() => Assert.Equal("hello, archon", await _client.Responses.GetTextAsync());

    [Fact]
    public async Task DecodesOctetStreamAsBytes()
    {
        var bytes = await _client.Responses.GetBinaryAsync();
        Assert.Equal(256, bytes.Length);
        Assert.Equal(0x00, bytes[0]);
        Assert.Equal(0xff, bytes[255]);
    }

    [Fact]
    public async Task ReturnsWithoutDataFor204NoContent()
    {
        var result = await _client.Responses.GetEmptyWithResponseAsync();
        Assert.Equal(204, result.StatusCode);
    }

    [Fact]
    public async Task ReturnsNullForAnEmptyBodyDeclaredAsJson()
    {
        var result = await _client.Responses.GetEmptyJsonWithResponseAsync();
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("application/json", result.Headers.Get("content-type"));
        Assert.Null(result.Data);
        Assert.Null(await _client.Responses.GetEmptyJsonAsync());
    }
}
