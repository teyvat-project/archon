using Archon.EdgeCases;
using Xunit;

namespace Archon.E2E.Tests;

public class RedirectTests
{
    [Fact]
    public async Task DropsCredentialsWhenARedirectCrossesOrigins()
    {
        var client = Env.Client(o =>
        {
            o.Auth = new ApiAuth { ApiKeyHeader = "test-key" };
            o.Headers["Authorization"] = "Bearer test-token";
        });
        var result = await client.Middleware.RedirectCrossOriginWithResponseAsync();
        Assert.Equal(200, result.StatusCode);
        Assert.Equal(new Uri(Env.SecondaryUrl).GetLeftPart(UriPartial.Authority), result.Url.GetLeftPart(UriPartial.Authority));
        Assert.Equal("/echo/headers", result.Data.Path);
        Assert.False(result.Data.Headers.ContainsKey("x-api-key"));
        Assert.False(result.Data.Headers.ContainsKey("authorization"));
    }
}
