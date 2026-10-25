using System.Collections.Concurrent;
using Xunit;

namespace Archon.Runtime.Tests;

public class OAuth2TokenManagerTests
{
    private static readonly HttpClient Http = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });

    private static TestServer TokenServer(ConcurrentQueue<RecordedRequest> seen, int expiresIn = 3600, TimeSpan? delay = null, int status = 200, string? refreshToken = null)
    {
        var n = 0;
        return TestServer.Start(r =>
        {
            seen.Enqueue(r);
            if (status != 200) return TestResponse.Json(status, "{\"error\":\"invalid_client\"}");
            var refresh = refreshToken is null ? "" : $",\"refresh_token\":\"{refreshToken}\"";
            return TestResponse.Json(200, $"{{\"access_token\":\"at{Interlocked.Increment(ref n)}\",\"expires_in\":{expiresIn}{refresh}}}") with { Delay = delay };
        });
    }

    private static OAuth2Value ClientCredentials(params string[] scopes)
        => new() { ClientCredentials = new() { ClientId = "client-id", ClientSecret = "client-secret", Scopes = scopes } };

    [Fact]
    public async Task FetchesClientCredentialsWithBasicClientAuth()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen);
        var manager = new OAuth2TokenManager(Http, ClientCredentials("write"), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        Assert.True(manager.Managed);
        Assert.Equal("at1", await manager.GetTokenAsync(["read"], default));
        var request = Assert.Single(seen);
        Assert.Equal("POST", request.Method);
        Assert.Equal("application/x-www-form-urlencoded", request.Header("content-type"));
        Assert.Equal("Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=", request.Header("authorization"));
        Assert.Equal("grant_type=client_credentials&scope=read+write", request.BodyText);
    }

    [Fact]
    public async Task PostClientAuthPutsCredentialsInTheForm()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen);
        var config = new OAuth2Value { ClientCredentials = new() { ClientId = "id", ClientSecret = "s", ClientAuth = OAuth2ClientAuth.Post } };
        await new OAuth2TokenManager(Http, config, new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2").GetTokenAsync([], default);
        Assert.Equal("grant_type=client_credentials&client_id=id&client_secret=s", Assert.Single(seen).BodyText);
        Assert.Null(seen.Single().Header("authorization"));
    }

    [Fact]
    public async Task CachesUntil30sBeforeExpiry()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen, expiresIn: 60);
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2", time);
        Assert.Equal("at1", await manager.GetTokenAsync([], default));
        time.Advance(TimeSpan.FromSeconds(29));
        Assert.Equal("at1", await manager.GetTokenAsync([], default));
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal("at2", await manager.GetTokenAsync([], default));
    }

    [Fact]
    public async Task SingleFlightForConcurrentCalls()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen, delay: TimeSpan.FromMilliseconds(300));
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        var tokens = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => manager.GetTokenAsync([], default)));
        Assert.All(tokens, t => Assert.Equal("at1", t));
        Assert.Single(seen);
    }

    [Fact]
    public async Task CancelledWaiterDoesNotCancelSharedFetch()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen, delay: TimeSpan.FromMilliseconds(500));
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        using var cts = new CancellationTokenSource();
        var cancelled = manager.GetTokenAsync([], cts.Token);
        var others = Enumerable.Range(0, 4).Select(_ => manager.GetTokenAsync([], default)).ToList();
        await Task.Delay(100);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.All(await Task.WhenAll(others), t => Assert.Equal("at1", t));
        Assert.Single(seen);
    }

    [Fact]
    public async Task RefreshGrantRotatesTokenAndCallsOnRefreshed()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen, expiresIn: 1, refreshToken: "rt-new");
        var refreshed = new List<TokenSet>();
        var config = new OAuth2Value
        {
            RefreshToken = new()
            {
                RefreshToken = "rt-old",
                ClientId = "id",
                ClientSecret = "s",
                OnRefreshed = (tokens, _) =>
                {
                    refreshed.Add(tokens);
                    return ValueTask.CompletedTask;
                },
            },
        };
        var manager = new OAuth2TokenManager(Http, config, new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        await manager.GetTokenAsync(["read"], default);
        await manager.GetTokenAsync([], default);   // expires_in 1 < leeway: fetched again with the rotated token
        Assert.Equal(["grant_type=refresh_token&refresh_token=rt-old", "grant_type=refresh_token&refresh_token=rt-new"], seen.Select(r => r.BodyText));
        Assert.Equal(2, refreshed.Count);
        Assert.Equal("rt-new", refreshed[0].RefreshToken);
    }

    [Fact]
    public async Task ResolvesRelativeTokenUrlAgainstBaseUrl()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen);
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), "/oauth/token", new Uri(server.Url, "/api/"), "oauth2");
        await manager.GetTokenAsync([], default);
        Assert.Equal("/oauth/token", Assert.Single(seen).Target);
    }

    [Fact]
    public async Task AuthExceptionOnTokenEndpointFailure()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen, status: 401);
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        var error = await Assert.ThrowsAsync<ApiAuthException>(() => manager.GetTokenAsync([], default));
        Assert.Equal(["oauth2"], error.Schemes);
        await Assert.ThrowsAsync<ApiAuthException>(() => new OAuth2TokenManager(Http, ClientCredentials(), null, null, "oauth2").GetTokenAsync([], default));
    }

    [Fact]
    public async Task InvalidateOnlyDropsTheRejectedToken()
    {
        var seen = new ConcurrentQueue<RecordedRequest>();
        using var server = TokenServer(seen);
        var manager = new OAuth2TokenManager(Http, ClientCredentials(), new Uri(server.Url, "/token").AbsoluteUri, null, "oauth2");
        await manager.GetTokenAsync([], default);
        manager.Invalidate("stale");
        Assert.Equal("at1", await manager.GetTokenAsync([], default));
        manager.Invalidate("at1");
        Assert.Equal("at2", await manager.GetTokenAsync([], default));
    }
}
