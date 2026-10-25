using System.Text.RegularExpressions;
using Xunit;
using static Archon.Runtime.Tests.TestApi;

namespace Archon.Runtime.Tests;

public class AuthTests
{
    private static readonly IReadOnlyDictionary<string, SecuritySchemeSpec> Schemes = new Dictionary<string, SecuritySchemeSpec>
    {
        ["bearer"] = new SecuritySchemeSpec.HttpBearer(),
        ["basic"] = new SecuritySchemeSpec.HttpBasic(),
        ["keyHeader"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
        ["keyQuery"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
        ["keyCookie"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Cookie, "session"),
        ["oauth"] = new SecuritySchemeSpec.OAuth2("/oauth/token"),
    };

    private static SecurityRequirement Req(params string[] schemes) => new(schemes.Select(s => new SecurityScheme(s, [])).ToList());

    private static Task<ApiResult<string>> Call(ApiClientCore core, params SecurityRequirement[] security)
        => core.SendAsync(Op("/x", security: security, responses: new() { ["200"] = ResponseKind.Text }), new RequestValues(), ResponseDecoder.Text, ErrorDecoders.None, null, default);

    private static ApiClientCore Core(Uri url, Dictionary<string, object?> auth, Action<TestOptions>? configure = null)
        => TestApi.Core(url, o =>
        {
            o.Auth = new TestAuth(auth);
            configure?.Invoke(o);
        }, Schemes);

    [Fact]
    public void SelectorPicksTheFirstSatisfiableAlternative()
    {
        bool None(string _) => false;
        Assert.IsType<Selection.Anonymous>(SecuritySelector.Select([], None));
        Assert.IsType<Selection.Anonymous>(SecuritySelector.Select([Req("bearer"), Req()], None));
        var missing = Assert.IsType<Selection.Missing>(SecuritySelector.Select([Req("bearer")], None));
        Assert.Equal(["bearer"], missing.Schemes);
        var apply = Assert.IsType<Selection.Apply>(SecuritySelector.Select([Req("bearer", "basic"), Req("basic")], s => s == "basic"));
        Assert.Equal("basic", Assert.Single(apply.Requirement.Schemes).Name);
    }

    [Fact]
    public async Task AppliesBearerFromAsyncProvider()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, new() { ["bearer"] = new TokenValue(async ct => { await Task.Yield(); return "tok"; }) });
        await Call(core, Req("bearer"));
        Assert.Equal("Bearer tok", server.Last.Header("authorization"));
    }

    [Fact]
    public async Task AppliesBasicWithUtf8()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, new() { ["basic"] = new BasicValue("user", "päss") });
        await Call(core, Req("basic"));
        Assert.Equal("Basic dXNlcjpww6Rzcw==", server.Last.Header("authorization"));
    }

    [Fact]
    public async Task AppliesApiKeyInHeaderQueryCookie()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, new() { ["keyHeader"] = (TokenValue)"h", ["keyQuery"] = (TokenValue)"q v", ["keyCookie"] = (TokenValue)"c;d" });
        await Call(core, Req("keyHeader", "keyQuery", "keyCookie"));
        Assert.Equal("h", server.Last.Header("x-api-key"));
        Assert.Equal("/x?api_key=q%20v", server.Last.Target);
        Assert.Equal("session=c%3Bd", server.Last.Header("cookie"));
    }

    [Fact]
    public async Task ThrowsAuthExceptionBeforeSending()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, new() { ["bearer"] = (TokenValue)"t" });
        var error = await Assert.ThrowsAsync<ApiAuthException>(() => Call(core, Req("bearer", "basic")));
        Assert.Equal(["basic"], error.Schemes);
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task ReappliesFreshTokenOnReentry()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var n = 0;
        var core = Core(server.Url, new() { ["bearer"] = new TokenValue(_ => ValueTask.FromResult($"t{++n}")) }, o =>
            o.Middleware.Add(ApiMiddleware.Create(async (req, next, ctx, ct) =>
            {
                (await next(req, ct)).Dispose();
                return await next(req, ct);
            })));
        await Call(core, Req("bearer"));
        Assert.Equal(["Bearer t1", "Bearer t2"], server.Requests.Select(r => r.Header("authorization")));
    }

    [Fact]
    public async Task RetriesOnceOn401WithManagedToken()
    {
        var issued = 0;
        using var server = TestServer.Start(r =>
        {
            if (r.Target == "/oauth/token") return TestResponse.Json(200, $"{{\"access_token\":\"at{++issued}\",\"expires_in\":3600}}");
            return r.Header("authorization") == "Bearer at2" ? new TestResponse(200, "ok") : new TestResponse(401, "no");
        });
        var core = Core(server.Url, new()
        {
            ["oauth"] = new OAuth2Value { ClientCredentials = new() { ClientId = "id", ClientSecret = "secret" } },
        });
        var result = await Call(core, new SecurityRequirement([new SecurityScheme("oauth", ["read"])]));
        Assert.Equal("ok", result.Data);
        Assert.Equal(2, issued);
        Assert.Equal(2, server.Requests.Count(r => r.Target == "/x"));
    }

    [Fact]
    public async Task DoesNotRetry401ForUnmanagedToken()
    {
        using var server = TestServer.Start(_ => new TestResponse(401, "no"));
        var core = Core(server.Url, new() { ["oauth"] = new OAuth2Value { AccessToken = "static" } });
        await Assert.ThrowsAsync<ApiException>(() => Call(core, Req("oauth")));
        Assert.Single(server.Requests);
        Assert.Equal("Bearer static", server.Last.Header("authorization"));
    }

    [Fact]
    public async Task CustomAuthCoversUnknownScheme()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url, new(), o => o.CustomAuth = (req, ctx, ct) =>
        {
            req.Headers.Set("Authorization", "Digest x");
            return ValueTask.CompletedTask;
        });
        await Call(core, Req("digest"));
        Assert.Equal("Digest x", server.Last.Header("authorization"));
    }
}
