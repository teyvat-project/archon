using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Archon.Runtime.Tests;

/// <summary>A request exactly as it arrived on the wire.</summary>
public sealed record RecordedRequest(string Method, string Target, Dictionary<string, string> Headers, byte[] Body)
{
    public string BodyText => Encoding.UTF8.GetString(Body);

    public string? Header(string name) => Headers.TryGetValue(name.ToLowerInvariant(), out var value) ? value : null;
}

public sealed record TestResponse(int Status, string Body = "", Dictionary<string, string>? Headers = null, TimeSpan? Delay = null)
{
    public static TestResponse Json(int status, string json, Dictionary<string, string>? headers = null)
        => new(status, json, new Dictionary<string, string>(headers ?? []) { ["Content-Type"] = "application/json" });
}

/// <summary>A minimal HTTP/1.1 server on 127.0.0.1 that records raw requests (one request per connection).</summary>
public sealed class TestServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly Func<RecordedRequest, TestResponse> _handler;
    private readonly CancellationTokenSource _stop = new();

    private TestServer(Func<RecordedRequest, TestResponse> handler)
    {
        _handler = handler;
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Url = new Uri($"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}");
        _ = AcceptLoop();
    }

    public Uri Url { get; }

    public ConcurrentQueue<RecordedRequest> Requests { get; } = new();

    public RecordedRequest Last => Requests.Last();

    public static TestServer Start(Func<RecordedRequest, TestResponse> handler) => new(handler);

    /// <summary>A port nothing listens on.</summary>
    public static int ClosedPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
    }

    private async Task AcceptLoop()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch
            {
                return;
            }
            _ = Task.Run(() => Serve(client));
        }
    }

    private async Task Serve(TcpClient client)
    {
        using var _ = client;
        var stream = client.GetStream();
        try
        {
            var head = await ReadHead(stream);
            if (head is null) return;
            var lines = head.Split("\r\n");
            var requestLine = lines[0].Split(' ');
            var headers = new Dictionary<string, string>();
            foreach (var line in lines.Skip(1))
            {
                var colon = line.IndexOf(':');
                if (colon <= 0) continue;
                var name = line[..colon].Trim().ToLowerInvariant();
                var value = line[(colon + 1)..].Trim();
                headers[name] = headers.TryGetValue(name, out var existing) ? $"{existing}, {value}" : value;
            }
            var body = await ReadBody(stream, headers);
            var request = new RecordedRequest(requestLine[0], requestLine[1], headers, body);
            Requests.Enqueue(request);

            var response = _handler(request);
            if (response.Delay is { } delay) await Task.Delay(delay);
            var bytes = Encoding.UTF8.GetBytes(response.Body);
            var builder = new StringBuilder();
            builder.Append($"HTTP/1.1 {response.Status} X\r\n");
            foreach (var (name, value) in response.Headers ?? []) builder.Append($"{name}: {value}\r\n");
            builder.Append($"Content-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(Encoding.ASCII.GetBytes(builder.ToString()));
            await stream.WriteAsync(bytes);
            await stream.FlushAsync();
        }
        catch
        {
            // The client went away (timeouts, cancellation): nothing to report.
        }
    }

    private static async Task<string?> ReadHead(NetworkStream stream)
    {
        var buffer = new List<byte>();
        var one = new byte[1];
        while (true)
        {
            if (await stream.ReadAsync(one) == 0) return null;
            buffer.Add(one[0]);
            var n = buffer.Count;
            if (n >= 4 && buffer[n - 4] == '\r' && buffer[n - 3] == '\n' && buffer[n - 2] == '\r' && buffer[n - 1] == '\n')
            {
                return Encoding.UTF8.GetString(buffer.ToArray(), 0, n - 4);
            }
        }
    }

    private static async Task<byte[]> ReadBody(NetworkStream stream, Dictionary<string, string> headers)
    {
        if (headers.TryGetValue("content-length", out var length))
        {
            var body = new byte[int.Parse(length)];
            await stream.ReadExactlyAsync(body);
            return body;
        }
        if (headers.TryGetValue("transfer-encoding", out var te) && te.Contains("chunked"))
        {
            var output = new MemoryStream();
            while (true)
            {
                var sizeLine = await ReadLine(stream);
                var size = Convert.ToInt32(sizeLine.Split(';')[0], 16);
                if (size == 0)
                {
                    await ReadLine(stream);
                    return output.ToArray();
                }
                var chunk = new byte[size];
                await stream.ReadExactlyAsync(chunk);
                output.Write(chunk);
                await ReadLine(stream);
            }
        }
        return [];
    }

    private static async Task<string> ReadLine(NetworkStream stream)
    {
        var buffer = new List<byte>();
        var one = new byte[1];
        while (await stream.ReadAsync(one) > 0)
        {
            if (one[0] == '\n') break;
            if (one[0] != '\r') buffer.Add(one[0]);
        }
        return Encoding.ASCII.GetString(buffer.ToArray());
    }
}
