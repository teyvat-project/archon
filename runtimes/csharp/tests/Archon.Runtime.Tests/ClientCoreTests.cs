using System.Net.Sockets;
using Xunit;
using static Archon.Runtime.Tests.TestApi;

namespace Archon.Runtime.Tests;

public class ClientCoreTests
{
    private static readonly ResponseDecoder<TestPet> Pet = ResponseDecoder.Json(TestJson.Default.TestPet);

    [Fact]
    public async Task BuildsUrlPreservingBaseUrlPath()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"x\"}"));
        var core = Core(new Uri(server.Url, "/api/"));
        var values = new RequestValues().Path("id", 1, TestJson.Default.Int32).Query("q", "a b", TestJson.Default.String);
        await core.SendAsync(Op("/foo/{id}", parameters: [P("id"), Q("q")]), values, Pet, ErrorDecoders.None, null, default);
        Assert.Equal("/api/foo/1?q=a%20b", server.Last.Target);
    }

    [Fact]
    public async Task SendsPipeAndBracketsUnchanged()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"x\"}"));
        var core = Core(server.Url);
        var values = new RequestValues()
            .Query("piped", [1, 2], TestJson.Default.ListInt32)
            .Query("filter", new Dictionary<string, int> { ["a"] = 1 }, TestJson.Default.DictionaryStringInt32);
        var parameters = new[]
        {
            new ParamSpec("piped", ParamLocation.Query, ParamStyle.PipeDelimited, false),
            new ParamSpec("filter", ParamLocation.Query, ParamStyle.DeepObject, true),
        };
        await core.SendAsync(Op("/q", parameters: parameters), values, Pet, ErrorDecoders.None, null, default);
        Assert.Equal("/q?piped=1|2&filter[a]=1", server.Last.Target);
    }

    [Fact]
    public async Task ReturnsTypedDataOn2xx()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"tama\",\"count\":3,\"extra\":true}", new() { ["X-Total"] = "7" }));
        var core = Core(server.Url, o => o.Headers["X-Static"] = "s");
        var result = await core.SendAsync(Op("/pets"), new RequestValues(), Pet, ErrorDecoders.None, new RequestOptions { Headers = { ["X-Call"] = "c" } }, default);
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("tama", result.Data.Name);
        Assert.Equal(3, result.Data.Count);
        Assert.Equal("7", result.Headers.Get("x-total"));
        Assert.Equal("application/json", server.Last.Header("accept"));
        Assert.Equal("s", server.Last.Header("x-static"));
        Assert.Equal("c", server.Last.Header("x-call"));
        Assert.Equal(new Uri(server.Url, "/pets").AbsoluteUri, result.Url.AbsoluteUri);
    }

    [Fact]
    public async Task ThrowsTypedApiExceptionOn404WithParsedBody()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(404, "{\"message\":\"nope\"}"));
        var core = Core(server.Url);
        var errors = new ErrorDecoders().Json("404", TestJson.Default.TestProblem);
        var error = await Assert.ThrowsAsync<ApiException<TestProblem>>(() => core.SendAsync(Op("/x"), new RequestValues(), Pet, errors, null, default));
        Assert.Equal(404, error.StatusCode);
        Assert.Equal("nope", error.Body.Message);
        Assert.Equal("{\"message\":\"nope\"}", error.RawBody);
    }

    [Fact]
    public async Task UsesRangeAndDefaultErrorDecoders()
    {
        using var server = TestServer.Start(r => TestResponse.Json(r.Target == "/a" ? 418 : 503, "{\"message\":\"m\"}"));
        var core = Core(server.Url);
        var errors = new ErrorDecoders().Json("4XX", TestJson.Default.TestProblem).Text("default");
        await Assert.ThrowsAsync<ApiException<TestProblem>>(() => core.SendAsync(Op("/a"), new RequestValues(), Pet, errors, null, default));
        var text = await Assert.ThrowsAsync<ApiException<string>>(() => core.SendAsync(Op("/b"), new RequestValues(), Pet, errors, null, default));
        Assert.Equal("{\"message\":\"m\"}", text.Body);
    }

    [Fact]
    public async Task ThrowsUntypedApiExceptionWhenErrorBodyIsNotJson()
    {
        using var server = TestServer.Start(_ => new TestResponse(500, "<html>"));
        var core = Core(server.Url);
        var errors = new ErrorDecoders().Json("default", TestJson.Default.TestProblem);
        var error = await Assert.ThrowsAsync<ApiException>(() => core.SendAsync(Op("/x"), new RequestValues(), Pet, errors, null, default));
        Assert.IsNotType<ApiException<TestProblem>>(error);
        Assert.Equal(500, error.StatusCode);
        Assert.Equal("<html>", error.RawBody);
    }

    [Fact]
    public async Task ReturnsDefaultFor204AndEmptyJson()
    {
        using var server = TestServer.Start(r => r.Target == "/204" ? new TestResponse(204) : TestResponse.Json(200, ""));
        var core = Core(server.Url);
        var noContent = await core.SendAsync(Op("/204"), new RequestValues(), Pet, ErrorDecoders.None, null, default);
        Assert.Equal(204, noContent.StatusCode);
        Assert.Null(noContent.Data);
        Assert.Null((await core.SendAsync(Op("/empty"), new RequestValues(), Pet, ErrorDecoders.None, null, default)).Data);
        var untyped = await core.SendAsync(Op("/204"), new RequestValues(), ErrorDecoders.None, null, default);
        Assert.Equal(204, untyped.StatusCode);
    }

    [Fact]
    public async Task DecodesTextAndBinary()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "hello"));
        var core = Core(server.Url);
        Assert.Equal("hello", (await core.SendAsync(Op("/t"), new RequestValues(), ResponseDecoder.Text, ErrorDecoders.None, null, default)).Data);
        Assert.Equal("hello"u8.ToArray(), (await core.SendAsync(Op("/b"), new RequestValues(), ResponseDecoder.Binary, ErrorDecoders.None, null, default)).Data);
        var op = Op("/t", responses: new() { ["200"] = ResponseKind.Text });
        await core.SendAsync(op, new RequestValues(), ResponseDecoder.Text, ErrorDecoders.None, null, default);
        Assert.Equal("*/*", server.Last.Header("accept"));
    }

    [Fact]
    public async Task ThrowsDecodeExceptionOnInvalidJson()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{not json"));
        var core = Core(server.Url);
        var error = await Assert.ThrowsAsync<ApiDecodeException>(() => core.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default));
        Assert.Equal("{not json", error.RawBody);
        Assert.Equal(200, error.StatusCode);
    }

    [Fact]
    public async Task ThrowsTransportExceptionOnConnectionRefusedAndTimeout()
    {
        var refused = Core(new Uri($"http://127.0.0.1:{TestServer.ClosedPort()}"));
        var error = await Assert.ThrowsAsync<ApiTransportException>(() => refused.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default));
        Assert.False(error.TimedOut);

        using var server = TestServer.Start(_ => new TestResponse(200, "{}", Delay: TimeSpan.FromSeconds(5)));
        var slow = Core(server.Url, o => o.Timeout = TimeSpan.FromMilliseconds(200));
        var timeout = await Assert.ThrowsAsync<ApiTransportException>(() => slow.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default));
        Assert.True(timeout.TimedOut);
    }

    [Fact]
    public async Task CallerCancellationThrowsOperationCanceled()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "{}", Delay: TimeSpan.FromSeconds(5)));
        var core = Core(server.Url, o => o.Timeout = TimeSpan.FromSeconds(30));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => core.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, cts.Token));
    }

    [Fact]
    public async Task RejectsRelativeBaseUrl()
    {
        var core = new ApiClientCore(new TestOptions { BaseUrl = "/api" }, NoSchemes);
        await Assert.ThrowsAsync<ArgumentException>(() => core.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default));
    }

    [Fact]
    public async Task RunsMiddlewareOuterToInnerWithAuthInnermost()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"x\"}"));
        var order = new List<string>();
        IApiMiddleware Recorder(string name) => ApiMiddleware.Create(async (req, next, ctx, ct) =>
        {
            order.Add($"{name}:before");
            var response = await next(req, ct);
            order.Add($"{name}:after");
            return response;
        });
        var core = Core(server.Url, o =>
        {
            o.Middleware.Add(Recorder("mw1"));
            o.Middleware.Add(Recorder("mw2"));
            o.CustomAuth = (_, _, _) =>
            {
                order.Add("auth");
                return ValueTask.CompletedTask;
            };
        });
        await core.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default);
        Assert.Equal(["mw1:before", "mw2:before", "auth", "mw2:after", "mw1:after"], order);
    }

    [Fact]
    public async Task UseAppendsMiddleware()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"x\"}"));
        var core = Core(server.Url, o => o.Middleware.Add(ApiMiddleware.Create((req, next, ctx, ct) =>
        {
            req.Headers.Set("X-Trace", "a");
            return next(req, ct);
        })));
        core.Use(ApiMiddleware.Create((req, next, ctx, ct) =>
        {
            req.Headers.Set("X-Trace", req.Headers.Get("X-Trace") + ",b");
            Assert.Equal("testOp", ctx.OperationName);
            Assert.Equal(1, ctx.Attempt);
            return next(req, ct);
        }));
        await core.SendAsync(Op("/x"), new RequestValues(), Pet, ErrorDecoders.None, null, default);
        Assert.Equal("a,b", server.Last.Header("x-trace"));
    }

    [Fact]
    public async Task SendsHeaderAndCookieParameters()
    {
        using var server = TestServer.Start(_ => TestResponse.Json(200, "{\"name\":\"x\"}"));
        var core = Core(server.Url);
        var parameters = new[]
        {
            new ParamSpec("X-Ids", ParamLocation.Header, ParamStyle.Simple, false),
            new ParamSpec("theme", ParamLocation.Cookie, ParamStyle.Form, true),
            new ParamSpec("tags", ParamLocation.Cookie, ParamStyle.Form, false),
        };
        var values = new RequestValues()
            .Header("X-Ids", ["a", "b"], TestJson.Default.ListString)
            .Cookie("theme", "dark", TestJson.Default.String)
            .Cookie("tags", ["x", "y"], TestJson.Default.ListString);
        await core.SendAsync(Op("/h", parameters: parameters), values, Pet, ErrorDecoders.None, null, default);
        Assert.Equal("a,b", server.Last.Header("x-ids"));
        Assert.Equal("theme=dark; tags=x,y", server.Last.Header("cookie"));
    }
}
