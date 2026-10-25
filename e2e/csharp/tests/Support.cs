using System.Text.Json;
using Archon.EdgeCases;
using Xunit;

// Every test talks to the same mock server, whose counters (/__stats) are compared before and after.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Archon.E2E.Tests;

internal static class Env
{
    public static string BaseUrl => Variable("ARCHON_E2E_BASE_URL");

    public static string SecondaryUrl => Variable("ARCHON_E2E_SECONDARY_URL");

    public static ApiClient Client(Action<ApiClientOptions>? configure = null)
    {
        var options = new ApiClientOptions { BaseUrl = BaseUrl };
        configure?.Invoke(options);
        return new ApiClient(options);
    }

    /// <summary>The mock server's counters: tokens issued and requests per raw path.</summary>
    public static async Task<(int TokensIssued, Dictionary<string, int> Requests)> StatsAsync()
    {
        using var http = new HttpClient();
        using var document = JsonDocument.Parse(await http.GetStringAsync($"{BaseUrl}/__stats"));
        var root = document.RootElement;
        var requests = root.GetProperty("requests").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32());
        return (root.GetProperty("tokensIssued").GetInt32(), requests);
    }

    public static async Task<int> RequestCountAsync(string path) => (await StatsAsync()).Requests.GetValueOrDefault(path);

    private static string Variable(string name)
        => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name} is not set; run the suite with `pnpm test:e2e:csharp`.");
}
