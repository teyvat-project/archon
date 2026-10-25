namespace Archon.Runtime.Tests;

internal sealed class TestOptions : ClientOptions
{
    public IAuthConfig? Auth { get; set; }

    public override IAuthConfig? AuthConfig => Auth;
}

internal static class TestApi
{
    public static readonly IReadOnlyDictionary<string, SecuritySchemeSpec> NoSchemes = new Dictionary<string, SecuritySchemeSpec>();

    public static ApiClientCore Core(Uri baseUrl, Action<TestOptions>? configure = null, IReadOnlyDictionary<string, SecuritySchemeSpec>? schemes = null)
    {
        var options = new TestOptions { BaseUrl = baseUrl.ToString() };
        configure?.Invoke(options);
        return new ApiClientCore(options, schemes ?? NoSchemes);
    }

    public static OperationSpec Op(
        string path,
        HttpMethod? method = null,
        ParamSpec[]? parameters = null,
        BodyKind? body = null,
        string? mediaType = null,
        Dictionary<string, ResponseKind>? responses = null,
        SecurityRequirement[]? security = null)
        => new(
            "testOp",
            method ?? HttpMethod.Get,
            path,
            ["test"],
            security ?? [],
            parameters ?? [],
            body,
            mediaType,
            responses ?? new Dictionary<string, ResponseKind> { ["200"] = ResponseKind.Json });

    public static ParamSpec Q(string name, bool explode = true) => new(name, ParamLocation.Query, ParamStyle.Form, explode);

    public static ParamSpec P(string name) => new(name, ParamLocation.Path, ParamStyle.Simple, false);
}
