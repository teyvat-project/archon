using System.Text;
using System.Text.Json;
using Archon.EdgeCases;
using Archon.EdgeCases.Core;
using Xunit;

namespace Archon.E2E.Tests;

public class BodiesTests
{
    private readonly ApiClient _client = Env.Client();

    [Fact]
    public async Task SendsAJsonBody()
    {
        var payload = new JsonPayload { Name = "archon", Count = 3, Tags = ["a", "b"], Note = null, Nested = new Nested { Flag = true } };
        var echo = await _client.Echo.EchoJsonAsync(payload);
        Assert.Equal("POST", echo.Method);
        Assert.Equal("application/json", echo.ContentType);
        var sent = JsonSerializer.Deserialize(echo.Body!, ApiJsonContext.Default.JsonPayload)!;
        Assert.Equal("archon", sent.Name);
        Assert.Equal(3, sent.Count);
        Assert.Equal(["a", "b"], sent.Tags!);
        Assert.True(sent.Nested!.Flag);
        // Optional nulls are not written (the "unset" vs "null" distinction is out of scope).
        Assert.DoesNotContain("note", echo.Body);
    }

    [Fact]
    public async Task SendsAUrlEncodedFormBodyWithRepeatedArrayFields()
    {
        var echo = await _client.Echo.EchoFormAsync(new EchoFormBody { Name = "a b&c", Count = 2, Tags = ["x", "y"] });
        Assert.Equal("application/x-www-form-urlencoded", echo.ContentType);
        Assert.Equal("name=a+b%26c&count=2&tags=x&tags=y", echo.Body);
    }

    [Fact]
    public async Task SendsAMultipartBodyWithFileNamesAndSizes()
    {
        var echo = await _client.Echo.EchoMultipartAsync(new EchoMultipartBody
        {
            Title = "hello",
            File = new ApiFile(new byte[10], "data.bin", "application/octet-stream"),
            Attachments = [new ApiFile("abc"u8.ToArray(), "a.txt"), new ApiFile("hello"u8.ToArray(), "b.txt")],
        });
        Assert.StartsWith("multipart/form-data; boundary=", echo.ContentType);
        Assert.Equal("{\"title\":\"hello\"}", echo.Body);
        Assert.Equal(
            [("file", "data.bin", 10), ("attachments", "a.txt", 3), ("attachments", "b.txt", 5)],
            echo.Files!.Select(f => (f.Field, f.Name, f.Size)));
    }

    [Fact]
    public async Task SendsABinaryBody()
    {
        var echo = await _client.Echo.EchoBinaryAsync(new ApiFile(Encoding.UTF8.GetBytes("raw bytes")));
        Assert.Equal("application/octet-stream", echo.ContentType);
        Assert.Equal("9", echo.Headers["content-length"]);
        Assert.Equal("raw bytes", echo.Body);
    }

    [Fact]
    public async Task SendsAPlainTextBody()
    {
        var echo = await _client.Echo.EchoTextAsync("hello, text");
        Assert.Equal("text/plain", echo.ContentType);
        Assert.Equal("hello, text", echo.Body);
    }

    [Fact]
    public async Task RoundTripsARecursiveAllOfTreeTheServerAssigningIds()
    {
        var result = await _client.Nodes.CreateNodeWithResponseAsync(new Node
        {
            Id = "placeholder",
            Name = "root",
            Labels = new() { ["env"] = "test" },
            Children =
            [
                new Node { Id = "placeholder", Name = "a", Children = [new Node { Id = "placeholder", Name = "a1", Children = [] }] },
                new Node { Id = "placeholder", Name = "b", Children = [] },
            ],
        });
        Assert.Equal(201, result.StatusCode);
        var root = result.Data;
        Assert.Equal(("n1", (string?)null, "root"), (root.Id, root.ParentId, root.Name));
        Assert.Equal("test", root.Labels!["env"]);
        Assert.Equal(["n2", "n4"], root.Children.Select(c => c.Id));
        Assert.All(root.Children, c => Assert.Equal("n1", c.ParentId));
        var a1 = Assert.Single(root.Children[0].Children);
        Assert.Equal(("n3", "n2", "a1"), (a1.Id, a1.ParentId, a1.Name));
        Assert.Empty(root.Children[1].Children);
    }
}
