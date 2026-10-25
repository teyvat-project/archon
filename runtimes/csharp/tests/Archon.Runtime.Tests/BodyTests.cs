using System.Text;
using System.Text.Json;
using Xunit;
using static Archon.Runtime.Tests.TestApi;

namespace Archon.Runtime.Tests;

public class BodyTests
{
    private static readonly Dictionary<string, ResponseKind> Text = new() { ["200"] = ResponseKind.Text };

    [Fact]
    public async Task EncodesJsonWithExactContentType()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url);
        var values = new RequestValues().JsonBody(new TestPet { Name = "a", Count = 2 }, TestJson.Default.TestPet);
        await core.SendAsync(Op("/x", HttpMethod.Post, body: BodyKind.Json, mediaType: "application/json", responses: Text), values, ResponseDecoder.Text, ErrorDecoders.None, null, default);
        Assert.Equal("application/json", server.Last.Header("content-type"));
        Assert.Equal("{\"name\":\"a\",\"count\":2}", server.Last.BodyText);
    }

    [Fact]
    public async Task EncodesTextAndBinaryWithMediaType()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url);
        await core.SendAsync(Op("/t", HttpMethod.Post, body: BodyKind.Text, mediaType: "text/plain", responses: Text), new RequestValues().TextBody("héllo"), ResponseDecoder.Text, ErrorDecoders.None, null, default);
        Assert.Equal("text/plain", server.Last.Header("content-type"));
        Assert.Equal("héllo", server.Last.BodyText);

        await core.SendAsync(Op("/b", HttpMethod.Post, body: BodyKind.Binary, mediaType: "application/octet-stream", responses: Text), new RequestValues().BinaryBody(new ApiFile(Encoding.UTF8.GetBytes("raw bytes"))), ResponseDecoder.Text, ErrorDecoders.None, null, default);
        Assert.Equal("application/octet-stream", server.Last.Header("content-type"));
        Assert.Equal("9", server.Last.Header("content-length"));
    }

    [Fact]
    public async Task EncodesFormWithRepeatedArrayFields()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url);
        var form = new TestForm { Name = "a b&c", Count = 2, Tags = ["x", "y"], Meta = new() { ["k"] = 1 } };
        await core.SendAsync(Op("/f", HttpMethod.Post, body: BodyKind.Form, mediaType: "application/x-www-form-urlencoded", responses: Text), new RequestValues().FormBody(form, TestJson.Default.TestForm), ResponseDecoder.Text, ErrorDecoders.None, null, default);
        Assert.Equal("application/x-www-form-urlencoded", server.Last.Header("content-type"));
        Assert.Equal("name=a+b%26c&count=2&tags=x&tags=y&meta=%7B%22k%22%3A1%7D", server.Last.BodyText);
    }

    [Fact]
    public async Task EncodesMultipartWithQuotedNamesAndFilenames()
    {
        using var server = TestServer.Start(_ => new TestResponse(200, "ok"));
        var core = Core(server.Url);
        var element = JsonSerializer.SerializeToElement(new TestForm { Name = "hello", Count = 1, Tags = ["a", "b"] }, TestJson.Default.TestForm);
        var body = MultipartBody.FromJson(element)
            .AddFile("file", new ApiFile(new byte[10], "data.bin", "application/octet-stream"))
            .AddFiles("attachments", [new ApiFile(Encoding.UTF8.GetBytes("abc"), "a.txt"), new ApiFile(Encoding.UTF8.GetBytes("hello"), "b.txt")])
            .AddFile("missing", null);
        await core.SendAsync(Op("/m", HttpMethod.Post, body: BodyKind.Multipart, mediaType: "multipart/form-data", responses: Text), new RequestValues().Body(body), ResponseDecoder.Text, ErrorDecoders.None, null, default);

        Assert.StartsWith("multipart/form-data; boundary=", server.Last.Header("content-type"));
        var text = server.Last.BodyText;
        Assert.Contains("Content-Disposition: form-data; name=\"name\"\r\n\r\nhello\r\n", text);
        Assert.Contains("Content-Disposition: form-data; name=\"count\"\r\n\r\n1\r\n", text);
        Assert.Contains("Content-Disposition: form-data; name=\"tags\"\r\n\r\na\r\n", text);
        Assert.Contains("Content-Disposition: form-data; name=\"tags\"\r\n\r\nb\r\n", text);
        Assert.Contains("Content-Disposition: form-data; name=\"file\"; filename=\"data.bin\"", text);
        Assert.Contains("Content-Disposition: form-data; name=\"attachments\"; filename=\"a.txt\"", text);
        Assert.DoesNotContain("filename*", text);
        Assert.DoesNotContain("missing", text);
    }

    [Fact]
    public void StreamBodyIsNotReplayable()
    {
        var body = new StreamBody(new MemoryStream([1, 2, 3]), "application/octet-stream");
        Assert.False(body.Replayable);
        Assert.False(new ApiRequest(HttpMethod.Post, ApiUrl.Create("http://127.0.0.1/"), body: body).Replayable);
        Assert.True(new BytesBody([1], null).Replayable);
        Assert.False(new MultipartBody().AddFile("f", new ApiFile(new MemoryStream([1]))).Replayable);
    }

    [Fact]
    public async Task MultipartBodyCanBeSentTwice()
    {
        var body = new MultipartBody().AddText("a", "1").AddFile("f", new ApiFile([1, 2], "f.bin"));
        var first = await body.CreateContent().ReadAsStringAsync();
        var second = await body.CreateContent().ReadAsStringAsync();
        Assert.Contains("name=\"a\"", first);
        Assert.Contains("name=\"a\"", second);
    }

    [Fact]
    public void ApiFileSerializesAsBase64InJson()
    {
        var options = new JsonSerializerOptions { TypeInfoResolver = FileJson.Default };
        var json = JsonSerializer.Serialize(new ApiFile([1, 2, 3]), FileJson.Default.ApiFile);
        Assert.Equal("\"AQID\"", json);
        Assert.Equal([1, 2, 3], JsonSerializer.Deserialize("\"AQID\"", FileJson.Default.ApiFile)!.Bytes);
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(ApiFile))]
internal partial class FileJson : System.Text.Json.Serialization.JsonSerializerContext;
