using System.Text.Json.Serialization;

namespace Archon.Runtime.Tests;

[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(int?))]
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(DateTimeOffset))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(List<string?>))]
[JsonSerializable(typeof(List<int>))]
[JsonSerializable(typeof(Dictionary<string, int>))]
[JsonSerializable(typeof(Dictionary<string, object>))]
[JsonSerializable(typeof(TestColor))]
[JsonSerializable(typeof(TestPet))]
[JsonSerializable(typeof(TestProblem))]
[JsonSerializable(typeof(TestForm))]
internal partial class TestJson : JsonSerializerContext;

/// <summary>An extensible-enum-like struct serialized as its raw string.</summary>
[JsonConverter(typeof(TestColorConverter))]
public readonly record struct TestColor(string Value);

internal sealed class TestColorConverter : JsonConverter<TestColor>
{
    public override TestColor Read(ref System.Text.Json.Utf8JsonReader reader, Type typeToConvert, System.Text.Json.JsonSerializerOptions options)
        => new(reader.GetString()!);

    public override void Write(System.Text.Json.Utf8JsonWriter writer, TestColor value, System.Text.Json.JsonSerializerOptions options)
        => writer.WriteStringValue(value.Value);
}

public sealed class TestPet
{
    [JsonPropertyName("name")]
    public required string Name { get; set; }

    [JsonPropertyName("count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Count { get; set; }
}

public sealed class TestProblem
{
    [JsonPropertyName("message")]
    public required string Message { get; set; }
}

public sealed class TestForm
{
    [JsonPropertyName("name")]
    public required string Name { get; set; }

    [JsonPropertyName("count")]
    public int Count { get; set; }

    [JsonPropertyName("tags")]
    public List<string>? Tags { get; set; }

    [JsonPropertyName("note")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Note { get; set; }

    [JsonPropertyName("meta")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, int>? Meta { get; set; }
}
