using Xunit;
using static Archon.Runtime.Tests.TestApi;

namespace Archon.Runtime.Tests;

public class TransportTests
{
    private static readonly IReadOnlyDictionary<string, SecuritySchemeSpec> Schemes = new Dictionary<string, SecuritySchemeSpec>
    {
        ["apiKeyHeader"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
        ["apiKeyQuery"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
    };

    private static readonly ResponseDecoder<string> Text = ResponseDecoder.Text;

    private static IApiMiddleware Credentials => ApiMiddleware.Create((req, next, ctx, ct) =>
    {
        req.Headers.Set("X-API-Key", "k");
        req.Headers.Set("Authorization", "Bearer t");
        req.Headers.Set("Cookie", "session=s");
        req.SetQueryParameter("api_key", "k");
        return next(req, ct);
    });

    [Fact]
    public async Task ManualRedirectStripsCredentialsOnCrossOriginHop()
    {
        using var target = TestServer.Start(_ => new TestResponse(200, "landed"));
        using var origin = TestServer.Start(_ => new TestResponse(302, "", new() { ["Location"] = new Uri(target.Url, "/echo?x=1").AbsoluteUri }));
        var core = Core(origin.Url, o => o.Middleware.Add(Credentials), Schemes);
        var result = await core.SendAsync(Op("/start"), new RequestValues(), Text, ErrorDecoders.None, null, default);

        Assert.Equal("landed", result.Data);
        Assert.Equal(target.Url.Port, result.Url.Port);
        Assert.Equal("k", origin.Last.Header("x-api-key"));
        var hop = target.Last;
        Assert.Equal("/echo?x=1", hop.Target);
        Assert.Null(hop.Header("x-api-key"));
        Assert.Null(hop.Header("authorization"));
        Assert.Null(hop.Header("cookie"));
    }

    [Fact]
    public async Task CrossOriginHopDropsApiKeyQuery()
    {
        using var target = TestServer.Start(_ => new TestResponse(200, "landed"));
        using var origin = TestServer.Start(_ => new TestResponse(307, "", new() { ["Location"] = new Uri(target.Url, "/echo?api_key=k&y=2").AbsoluteUri }));
        var core = Core(origin.Url, o => o.Middleware.Add(Credentials), Schemes);
        await core.SendAsync(Op("/start"), new RequestValues(), Text, ErrorDecoders.None, null, default);
        Assert.Equal("/echo?y=2", target.Last.Target);
    }

    [Fact]
    public async Task SameOriginRedirectKeepsHeaders()
    {
        using var server = TestServer.Start(r => r.Target.StartsWith("/start") ? new TestResponse(301, "", new() { ["Location"] = "/next" }) : new TestResponse(200, "ok"));
        var core = Core(server.Url, o => o.Middleware.Add(Credentials), Schemes);
        await core.SendAsync(Op("/start"), new RequestValues(), Text, ErrorDecoders.None, null, default);
        Assert.Equal("/next", server.Last.Target);
        Assert.Equal("k", server.Last.Header("x-api-key"));
        Assert.Equal("Bearer t", server.Last.Header("authorization"));
    }

    [Fact]
    public async Task SeeOtherConvertsPostToGet()
    {
        using var server = TestServer.Start(r => r.Target == "/start" ? new TestResponse(303, "", new() { ["Location"] = "/next" }) : new TestResponse(200, "ok"));
        var core = Core(server.Url);
        await core.SendAsync(Op("/start", HttpMethod.Post, body: BodyKind.Text, mediaType: "text/plain"), new RequestValues().TextBody("payload"), Text, ErrorDecoders.None, null, default);
        var hop = server.Last;
        Assert.Equal("GET", hop.Method);
        Assert.Empty(hop.Body);
        Assert.Null(hop.Header("content-type"));
    }

    [Fact]
    public async Task TemporaryRedirectResendsTheBody()
    {
        using var server = TestServer.Start(r => r.Target == "/start" ? new TestResponse(307, "", new() { ["Location"] = "/next" }) : new TestResponse(200, "ok"));
        var core = Core(server.Url);
        await core.SendAsync(Op("/start", HttpMethod.Post, body: BodyKind.Text, mediaType: "text/plain"), new RequestValues().TextBody("payload"), Text, ErrorDecoders.None, null, default);
        Assert.Equal("POST", server.Last.Method);
        Assert.Equal("payload", server.Last.BodyText);
    }

    [Fact]
    public async Task UserHttpClientIsUsed()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var handler = new RecordingHandler(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
        using var http = new HttpClient(handler);
        var core = Core(server.Url, o => o.HttpClient = http);
        await core.SendAsync(Op("/x"), new RequestValues(), Text, ErrorDecoders.None, null, default);
        Assert.Equal(1, handler.Calls);
    }

    private sealed class RecordingHandler(HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        public int Calls;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            return base.SendAsync(request, cancellationToken);
        }
    }
}
