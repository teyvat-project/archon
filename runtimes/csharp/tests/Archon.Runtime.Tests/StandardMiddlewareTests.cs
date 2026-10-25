using Xunit;
using static Archon.Runtime.Tests.TestApi;

namespace Archon.Runtime.Tests;

public class StandardMiddlewareTests
{
    private static readonly Dictionary<string, ResponseKind> Text = new() { ["200"] = ResponseKind.Text };

    private static Task<ApiResult<string>> Get(ApiClientCore core, string path = "/x", HttpMethod? method = null, RequestValues? values = null, OperationSpec? op = null)
        => core.SendAsync(op ?? Op(path, method, responses: Text), values ?? new RequestValues(), ResponseDecoder.Text, ErrorDecoders.None, null, default);

    private static TestServer Flaky(int failures, int status = 503, Dictionary<string, string>? headers = null)
    {
        var n = 0;
        return TestServer.Start(_ => Interlocked.Increment(ref n) <= failures ? new TestResponse(status, "busy", headers) : new TestResponse(200, "ok"));
    }

    [Fact]
    public async Task Retries503WithRetryAfterSeconds()
    {
        using var server = Flaky(1, headers: new() { ["Retry-After"] = "1" });
        var delays = new List<TimeSpan>();
        var attempts = new List<int>();
        var core = Core(server.Url, o =>
        {
            o.Middleware.Add(new RetryMiddleware(new RetryOptions { Delay = (d, _) => { delays.Add(d); return Task.CompletedTask; } }));
            o.Middleware.Add(ApiMiddleware.Create((req, next, ctx, ct) => { attempts.Add(ctx.Attempt); return next(req, ct); }));
        });
        Assert.Equal("ok", (await Get(core)).Data);
        Assert.Equal([TimeSpan.FromSeconds(1)], delays);
        Assert.Equal([1, 2], attempts);
    }

    [Fact]
    public async Task DoesNotRetryPostByDefault()
    {
        using var server = Flaky(1);
        var core = Core(server.Url, o => o.Middleware.Add(new RetryMiddleware(new RetryOptions { Delay = (_, _) => Task.CompletedTask })));
        await Assert.ThrowsAsync<ApiException>(() => Get(core, method: HttpMethod.Post));
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task DoesNotRetryNonReplayable()
    {
        using var server = Flaky(1);
        var core = Core(server.Url, o => o.Middleware.Add(new RetryMiddleware(new RetryOptions { Delay = (_, _) => Task.CompletedTask })));
        var op = Op("/x", HttpMethod.Put, body: BodyKind.Binary, mediaType: "application/octet-stream", responses: Text);
        var values = new RequestValues().BinaryBody(new ApiFile(new MemoryStream([1, 2, 3])));
        await Assert.ThrowsAsync<ApiException>(() => Get(core, op: op, values: values));
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task StopsAfterMaxAttempts()
    {
        using var server = Flaky(10);
        var core = Core(server.Url, o => o.Middleware.Add(new RetryMiddleware(new RetryOptions { MaxAttempts = 2, Delay = (_, _) => Task.CompletedTask })));
        var error = await Assert.ThrowsAsync<ApiException>(() => Get(core));
        Assert.Equal(503, error.StatusCode);
        Assert.Equal(2, server.Requests.Count);
    }

    [Fact]
    public async Task RetriesNetworkErrors()
    {
        var calls = 0;
        var core = Core(new Uri("http://127.0.0.1:1"), o =>
        {
            o.Middleware.Add(new RetryMiddleware(new RetryOptions { Delay = (_, _) => Task.CompletedTask }));
            o.Middleware.Add(ApiMiddleware.Create((req, next, ctx, ct) =>
            {
                if (++calls < 3) throw new ApiTransportException("boom");
                return Task.FromResult(new ApiResponse(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent("ok") }, req.Url));
            }));
        });
        Assert.Equal("ok", (await Get(core)).Data);
        Assert.Equal(3, calls);
    }

    [Fact]
    public async Task DoesNotRetryTimeouts()
    {
        var calls = 0;
        var core = Core(new Uri("http://127.0.0.1:1"), o =>
        {
            o.Middleware.Add(new RetryMiddleware(new RetryOptions { Delay = (_, _) => Task.CompletedTask }));
            o.Middleware.Add(ApiMiddleware.Create((req, next, ctx, ct) =>
            {
                calls++;
                throw new ApiTransportException("slow", timedOut: true);
            }));
        });
        await Assert.ThrowsAsync<ApiTransportException>(() => Get(core));
        Assert.Equal(1, calls);
    }

    [Theory]
    [InlineData(0.0, 1, 100)]
    [InlineData(1.0, 1, 200)]
    [InlineData(0.0, 3, 400)]
    [InlineData(1.0, 10, 5000)]
    public void EqualJitterBounds(double random, int attempt, double expectedMs)
    {
        var options = new RetryOptions { Random = () => random };
        Assert.Equal(TimeSpan.FromMilliseconds(expectedMs), RetryMiddleware.Backoff(options, attempt));
    }

    [Fact]
    public async Task Retry401RetriesOnceWithFreshAuth()
    {
        using var server = TestServer.Start(r => r.Header("authorization") == "Bearer good" ? new TestResponse(200, "ok") : new TestResponse(401, "no"));
        var token = "expired";
        var seenAttempts = new List<int>();
        var schemes = new Dictionary<string, SecuritySchemeSpec> { ["bearer"] = new SecuritySchemeSpec.HttpBearer() };
        var core = Core(server.Url, o =>
        {
            o.Auth = new TestAuth(new() { ["bearer"] = new TokenValue(_ => ValueTask.FromResult(token)) });
            o.Middleware.Add(new Retry401Middleware((ctx, response, ct) =>
            {
                seenAttempts.Add(ctx.Attempt);
                token = "good";
                return ValueTask.FromResult(true);
            }));
        }, schemes);
        var op = Op("/x", responses: Text, security: [new SecurityRequirement([new SecurityScheme("bearer", [])])]);
        Assert.Equal("ok", (await Get(core, op: op)).Data);
        Assert.Equal([1], seenAttempts);
        Assert.Equal(["Bearer expired", "Bearer good"], server.Requests.Select(r => r.Header("authorization")));
    }

    [Fact]
    public async Task LoggingMasksAuthorizationCookieAndApiKeyQuery()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var lines = new List<string>();
        var schemes = new Dictionary<string, SecuritySchemeSpec>
        {
            ["keyHeader"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
            ["keyQuery"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
        };
        var core = Core(server.Url, o =>
        {
            o.Headers["Authorization"] = "Bearer secret-token";
            o.Headers["X-API-Key"] = "secret-key";
            o.Headers["Cookie"] = "theme=dark";
            o.Headers["X-Custom"] = "visible";
            o.Middleware.Add(ApiMiddleware.Create((req, next, ctx, ct) => { req.SetQueryParameter("api_key", "secret-key"); return next(req, ct); }));
            o.Middleware.Add(new LoggingMiddleware(new LoggingOptions { Log = lines.Add, IncludeHeaders = true, RedactHeaders = ["X-Custom-Secret"] }));
        }, schemes);
        await Get(core, "/echo");

        var all = string.Join("\n", lines);
        Assert.Equal($"→ GET {server.Url.AbsoluteUri.TrimEnd('/')}/echo?api_key=***", lines[0]);
        Assert.Contains("  Authorization: ***", lines);
        Assert.Contains("  X-API-Key: ***", lines);
        Assert.Contains("  Cookie: ***", lines);
        Assert.Contains("  X-Custom: visible", lines);
        Assert.DoesNotContain("secret", all);
        Assert.DoesNotContain("dark", all);
        Assert.Matches(@"^← 200 \(\d+ms\)$", lines[^1]);
    }

    [Fact]
    public async Task UserAgentSetsHeader()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, o => o.Middleware.Add(new UserAgentMiddleware("archon-test/1.0")));
        await Get(core);
        Assert.Equal("archon-test/1.0", server.Last.Header("user-agent"));
    }
}
