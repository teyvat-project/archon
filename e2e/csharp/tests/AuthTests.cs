using Archon.EdgeCases;
using Archon.EdgeCases.Core;
using Xunit;

namespace Archon.E2E.Tests;

public class AuthTests
{
    private static OAuth2ClientCredentials ClientCredentials => new() { ClientId = "client-id", ClientSecret = "client-secret" };

    [Fact]
    public async Task Bearer()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { BearerAuth = "test-token" });
        var result = await client.Auth.AuthBearerWithResponseAsync();
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("Bearer test-token", result.Data.Headers["authorization"]);
    }

    [Fact]
    public async Task Basic()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { BasicAuth = new BasicValue("user", "pass") });
        Assert.Equal(200, (await client.Auth.AuthBasicWithResponseAsync()).StatusCode);
    }

    [Fact]
    public async Task ApiKeyInAHeader()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { ApiKeyHeader = "test-key" });
        Assert.Equal("test-key", (await client.Auth.AuthApiKeyHeaderAsync()).Headers["x-api-key"]);
    }

    [Fact]
    public async Task ApiKeyInTheQuery()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { ApiKeyQuery = new TokenValue(_ => ValueTask.FromResult("test-key")) });
        Assert.Equal("api_key=test-key", (await client.Auth.AuthApiKeyQueryAsync()).Query);
    }

    [Fact]
    public async Task ApiKeyInACookie()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { ApiKeyCookie = "test-key" });
        Assert.Equal(new Dictionary<string, string> { ["session"] = "test-key" }, (await client.Auth.AuthApiKeyCookieAsync()).Cookies);
    }

    [Fact]
    public async Task RejectsAWrongCredentialWithATyped401()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { BearerAuth = "wrong" });
        var error = await Assert.ThrowsAsync<ApiException<Error>>(() => client.Auth.AuthBearerAsync());
        Assert.Equal(401, error.StatusCode);
        Assert.Equal(401, error.Body.Code);
        Assert.False(string.IsNullOrEmpty(error.Body.Message));
    }

    [Fact]
    public async Task ThrowsAuthExceptionWithoutSendingWhenRequiredAuthIsMissing()
    {
        var before = await Env.RequestCountAsync("/auth/bearer");
        var error = await Assert.ThrowsAsync<ApiAuthException>(() => Env.Client().Auth.AuthBearerAsync());
        Assert.Equal(["bearerAuth"], error.Schemes);
        Assert.Equal(before, await Env.RequestCountAsync("/auth/bearer"));
    }

    [Fact]
    public async Task SendsAnonymouslyWhenAuthIsOptionalAndNotConfigured()
    {
        var echo = await Env.Client().Auth.AuthOptionalAsync();
        Assert.False(echo.Headers.ContainsKey("authorization"));
    }

    [Fact]
    public async Task UsesTheCredentialForOptionalAuthWhenItIsConfigured()
    {
        var echo = await Env.Client(o => o.Auth = new ApiAuth { BearerAuth = "test-token" }).Auth.AuthOptionalAsync();
        Assert.Equal("Bearer test-token", echo.Headers["authorization"]);
    }

    [Fact]
    public async Task RequiresEverySchemeOfAnAndRequirement()
    {
        var before = await Env.RequestCountAsync("/auth/and");
        var partial = Env.Client(o => o.Auth = new ApiAuth { BearerAuth = "test-token" });
        await Assert.ThrowsAsync<ApiAuthException>(() => partial.Auth.AuthAndAsync());
        Assert.Equal(before, await Env.RequestCountAsync("/auth/and"));

        var both = Env.Client(o => o.Auth = new ApiAuth { BearerAuth = "test-token", ApiKeyHeader = "test-key" });
        Assert.Equal(200, (await both.Auth.AuthAndWithResponseAsync()).StatusCode);
    }

    [Fact]
    public async Task OAuth2ObtainsATokenWithClientCredentialsFromTheRelativeTokenUrl()
    {
        var before = await Env.StatsAsync();
        var client = Env.Client(o => o.Auth = new ApiAuth { Oauth2 = new OAuth2Value { ClientCredentials = ClientCredentials } });
        var echo = await client.Auth.AuthOAuth2Async();
        Assert.StartsWith("Bearer ", echo.Headers["authorization"]);
        Assert.Equal(before.TokensIssued + 1, (await Env.StatsAsync()).TokensIssued);
    }

    [Fact]
    public async Task OAuth2ObtainsATokenWithTheRefreshTokenGrant()
    {
        var refreshed = new List<string?>();
        var client = Env.Client(o => o.Auth = new ApiAuth
        {
            Oauth2 = new OAuth2Value
            {
                RefreshToken = new()
                {
                    RefreshToken = "test-refresh-token",
                    ClientId = "client-id",
                    ClientSecret = "client-secret",
                    OnRefreshed = (tokens, _) =>
                    {
                        refreshed.Add(tokens.RefreshToken);
                        return ValueTask.CompletedTask;
                    },
                },
            },
        });
        Assert.Equal(200, (await client.Auth.AuthOAuth2WithResponseAsync()).StatusCode);
        var rotated = Assert.Single(refreshed);
        Assert.NotEqual("test-refresh-token", rotated);
    }

    [Fact]
    public async Task OAuth2RenewsTheTokenBeforeItExpiresInsteadOfWaitingForA401()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { Oauth2 = new OAuth2Value { ClientCredentials = ClientCredentials } });
        var before = await Env.StatsAsync();

        var first = await client.Auth.AuthOAuth2Async();
        // The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
        await Task.Delay(TimeSpan.FromMilliseconds(2100));
        var second = await client.Auth.AuthOAuth2Async();
        Assert.NotEqual(first.Headers["authorization"], second.Headers["authorization"]);

        var after = await Env.StatsAsync();
        Assert.Equal(2, after.TokensIssued - before.TokensIssued);
        Assert.Equal(2, after.Requests.GetValueOrDefault("/auth/oauth2") - before.Requests.GetValueOrDefault("/auth/oauth2"));
    }

    [Fact]
    public async Task OAuth2IssuesASingleTokenForConcurrentRequestsOnAColdClient()
    {
        var client = Env.Client(o => o.Auth = new ApiAuth { Oauth2 = new OAuth2Value { ClientCredentials = ClientCredentials } });
        var before = await Env.StatsAsync();
        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => client.Auth.AuthOAuth2Async()));
        Assert.Single(results.Select(r => r.Headers["authorization"]).Distinct());
        Assert.Equal(1, (await Env.StatsAsync()).TokensIssued - before.TokensIssued);
    }
}
