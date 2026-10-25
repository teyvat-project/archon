using Archon.EdgeCases;
using Archon.EdgeCases.Core;
using Xunit;

namespace Archon.E2E.Tests;

public class ErrorsTests
{
    private readonly ApiClient _client = Env.Client();

    [Fact]
    public async Task ReturnsTheSuccessBodyFor200() => Assert.True((await _client.Errors.GetErrorAsync(200)).Ok);

    [Fact]
    public async Task ThrowsATypedErrorBodyFor404()
    {
        var error = await Assert.ThrowsAsync<ApiException<NotFoundError>>(() => _client.Errors.GetErrorAsync(404));
        Assert.Equal(404, error.StatusCode);
        Assert.Equal(("Not found", "errors/404"), (error.Body.Message, error.Body.Resource));
    }

    [Fact]
    public async Task ThrowsThe400ValidationErrorBody()
    {
        var error = await Assert.ThrowsAsync<ApiException<ValidationError>>(() => _client.Errors.GetErrorAsync(400));
        Assert.Equal(400, error.StatusCode);
        Assert.Equal("Validation failed", error.Body.Message);
        var field = Assert.Single(error.Body.Fields);
        Assert.Equal(("status", "invalid"), (field.Name, field.Reason));
    }

    [Theory]
    [InlineData(418)]
    [InlineData(500)]
    public async Task ThrowsTheDefaultErrorBodyForAnyOtherStatus(int status)
    {
        var error = await Assert.ThrowsAsync<ApiException<Error>>(() => _client.Errors.GetErrorAsync(status));
        Assert.Equal(status, error.StatusCode);
        Assert.Equal(status, error.Body.Code);
    }
}
