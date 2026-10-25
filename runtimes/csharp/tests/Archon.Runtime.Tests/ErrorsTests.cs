using Xunit;

namespace Archon.Runtime.Tests;

public class ErrorsTests
{
    [Fact]
    public void ApiExceptionOfTExposesStatusBodyAndRaw()
    {
        var headers = new ApiHeaders();
        headers.Set("X-A", "1");
        var url = new Uri("http://127.0.0.1/x");
        var error = new ApiException<string>(404, headers, "\"nope\"", url, "nope");
        ApiException baseError = error;
        Assert.Equal(404, baseError.StatusCode);
        Assert.Equal("\"nope\"", baseError.RawBody);
        Assert.Equal("1", baseError.Headers.Get("x-a"));
        Assert.Equal(url, baseError.Url);
        Assert.Equal("nope", error.Body);
        Assert.Contains("404", error.Message);
    }

    [Fact]
    public void OtherExceptionsCarryTheirDetails()
    {
        Assert.True(new ApiTransportException("t", null, timedOut: true).TimedOut);
        Assert.Equal("raw", new ApiDecodeException("d", 200, "raw", null).RawBody);
        Assert.Equal(["bearerAuth"], new ApiAuthException("a", ["bearerAuth"]).Schemes);
    }
}
