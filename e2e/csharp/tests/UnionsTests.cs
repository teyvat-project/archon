using Archon.EdgeCases;
using Xunit;

namespace Archon.E2E.Tests;

public class UnionsTests
{
    private readonly ApiClient _client = Env.Client();

    private static string Describe(Shape shape) => shape switch
    {
        Circle c => $"circle r={c.Radius}",
        Square s => $"square s={s.Side}",
        _ => $"unknown side={shape.AdditionalProperties?["side"].GetInt32()}",
    };

    [Fact]
    public async Task NarrowsADiscriminatedUnionAndKeepsAnUnknownVariantAsTheBaseType()
    {
        var shapes = await _client.Unions.ListShapesAsync();
        Assert.Equal(["circle r=1", "square s=2", "unknown side=3"], shapes.Select(Describe));
        Assert.Equal(typeof(Shape), shapes[2].GetType());
    }

    [Fact]
    public async Task ReceivesAnUntaggedUnionByTryingVariantsInOrder()
    {
        var pets = await _client.Unions.ListPetsAsync();
        Assert.Equal(("Tama", true), (pets[0].Cat!.Name, pets[0].Cat!.Meows));
        Assert.Null(pets[0].Dog);
        Assert.Equal(("Pochi", true), (pets[1].Dog!.Name, pets[1].Dog!.Barks));
        Assert.Equal(["meow", "woof"], pets.Select(p => p.Cat is not null ? "meow" : "woof"));
    }

    [Fact]
    public async Task ReceivesKnownAndUnknownEnumValuesWithoutFailing()
    {
        var values = await _client.Unions.GetEnumValuesAsync();
        Assert.Equal(Status.Active, values.Status);
        Assert.Equal(Priority._2, values.Priority);
        Assert.Equal(Status.Pending, values.Statuses[0]);
        Assert.False(values.Statuses[1].IsKnown);
        Assert.Equal("archived", values.Statuses[1].Value);
        Assert.Null(values.Color);
        Assert.False(values.Level!.Value.IsKnown);
        Assert.Equal("unknown-level", values.Level.Value.Value);
    }

    [Fact]
    public async Task RevivesDateTimeAndDateValuesIncludingNestedArrays()
    {
        var dates = await _client.Unions.GetDatesAsync();
        Assert.Equal(DateTimeOffset.Parse("2026-10-25T12:34:56.789Z"), dates.CreatedAt);
        Assert.Equal(new DateOnly(2000, 1, 2), dates.Birthday);
        Assert.Null(dates.UpdatedAt);
        Assert.Equal(2, dates.Timestamps!.Count);
        Assert.Equal(TimeSpan.FromHours(9), dates.Timestamps[0].Offset);
        Assert.Equal(DateTimeOffset.Parse("2026-10-26T00:00:00Z"), dates.Timestamps[1]);
        var entry = dates.History[0];
        Assert.Equal(DateTimeOffset.Parse("2026-10-25T00:00:00Z"), entry.At);
        Assert.Equal(3, entry.Days.SelectMany(d => d).Count());
        Assert.Equal(new DateOnly(2026, 10, 3), entry.Days[1][0]);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:00:00Z"), dates.ByKey!["first"]);
    }
}
