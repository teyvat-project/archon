namespace Archon.Runtime.Tests;

/// <summary>A clock the test moves by hand.</summary>
internal sealed class FakeTimeProvider(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}

internal sealed class TestAuth(Dictionary<string, object?> values) : IAuthConfig
{
    public object? Get(string scheme) => values.GetValueOrDefault(scheme);
}
