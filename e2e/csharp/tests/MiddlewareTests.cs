using Archon.EdgeCases;
using Archon.EdgeCases.Core;
using Xunit;

namespace Archon.E2E.Tests;

public class MiddlewareTests
{
    [Fact]
    public async Task Retries503ResponsesUntilTheEndpointSucceeds()
    {
        var client = Env.Client(o => o.Middleware.Add(new RetryMiddleware()));
        var key = $"retry-{Guid.NewGuid()}";
        var data = await client.Middleware.FlakyAsync(key, fail: 2);
        Assert.Equal((key, 3), (data.Key, data.Attempts));
    }

    [Fact]
    public async Task GivesUpAfterMaxAttemptsAndThrowsTheTyped503()
    {
        var client = Env.Client(o => o.Middleware.Add(new RetryMiddleware(new RetryOptions { MaxAttempts = 2 })));
        var error = await Assert.ThrowsAsync<ApiException<Error>>(() => client.Middleware.FlakyAsync($"give-up-{Guid.NewGuid()}", fail: 5));
        Assert.Equal(503, error.StatusCode);
        Assert.Equal(503, error.Body.Code);
    }

    [Fact]
    public async Task ReSendsOnceAfterA401WhenTheTokenWasSwappedByRetry401()
    {
        var token = "expired-token";
        var swaps = new List<int>();
        var client = Env.Client(o =>
        {
            o.Auth = new ApiAuth { BearerAuth = new TokenValue(_ => ValueTask.FromResult(token)) };
            o.Middleware.Add(new Retry401Middleware((ctx, _, _) =>
            {
                swaps.Add(ctx.Attempt);
                token = "test-token";
                return ValueTask.FromResult(true);
            }));
        });
        var echo = await client.Auth.AuthBearerAsync();
        Assert.Equal("Bearer test-token", echo.Headers["authorization"]);
        Assert.Equal([1], swaps);
    }

    [Fact]
    public async Task MasksCredentialsInLogs()
    {
        var lines = new List<string>();
        // Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
        var withQueryKey = ApiMiddleware.Create((req, next, ctx, ct) =>
        {
            req.SetQueryParameter("api_key", "test-key");
            return next(req, ct);
        });
        var client = Env.Client(o =>
        {
            o.Headers["Authorization"] = "Bearer test-token";
            o.Headers["X-API-Key"] = "test-key";
            o.Middleware.Add(withQueryKey);
            o.Middleware.Add(new LoggingMiddleware(new LoggingOptions { Log = lines.Add, IncludeHeaders = true }));
        });
        var echo = await client.Echo.EchoHeadersCookiesAsync(["r1"], "dark");
        // The server did receive the credentials...
        Assert.Equal("Bearer test-token", echo.Headers["authorization"]);
        Assert.Equal("test-key", echo.Headers["x-api-key"]);
        Assert.Equal("api_key=test-key", echo.Query);

        // ...but the log did not.
        var logged = string.Join('\n', lines);
        Assert.DoesNotContain("test-token", logged);
        Assert.DoesNotContain("test-key", logged);
        Assert.DoesNotContain("dark", logged);
        Assert.Equal($"→ GET {Env.BaseUrl}/echo/headers?api_key=***", lines[0]);
        var headers = lines.Skip(1).SkipLast(1).Select(l => l.Trim().ToLowerInvariant()).ToList();
        Assert.Contains("authorization: ***", headers);
        Assert.Contains("x-api-key: ***", headers);
        Assert.Contains("cookie: ***", headers);
        Assert.Contains("x-request-ids: r1", headers);
        Assert.Matches(@"^← 200 \(\d+ms\)$", lines[^1]);
    }

    [Fact]
    public async Task SetsTheUserAgent()
    {
        var client = Env.Client(o => o.Middleware.Add(new UserAgentMiddleware("archon-e2e/1.0")));
        Assert.Equal("archon-e2e/1.0", (await client.Echo.EchoHeadersCookiesAsync(["r1"], "dark")).Headers["user-agent"]);
    }

    [Fact]
    public async Task RunsMiddlewareInRegistrationOrderConfigFirstThenUse()
    {
        var order = new List<string>();
        IApiMiddleware Tag(string name) => ApiMiddleware.Create(async (req, next, ctx, ct) =>
        {
            order.Add($">{name}");
            var trace = req.Headers.Get("X-Trace");
            req.Headers.Set("X-Trace", trace is null ? name : $"{trace},{name}");
            var response = await next(req, ct);
            order.Add($"<{name}");
            return response;
        });
        var client = Env.Client(o =>
        {
            o.Middleware.Add(Tag("a"));
            o.Middleware.Add(Tag("b"));
        });
        client.Use(Tag("c"));
        var echo = await client.Echo.EchoHeadersCookiesAsync(["r1"], "dark");
        Assert.Equal("a,b,c", echo.Headers["x-trace"]);
        Assert.Equal([">a", ">b", ">c", "<c", "<b", "<a"], order);
    }
}
