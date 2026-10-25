using Xunit;

namespace Archon.Runtime.Tests;

public class ParameterSerializerTests
{
    private static readonly List<string> Array = ["blue", "black", "brown"];
    private static readonly Dictionary<string, int> Object = new() { ["R"] = 100, ["G"] = 200, ["B"] = 150 };

    private static ParamSpec Spec(ParamLocation location, ParamStyle style, bool explode, bool allowReserved = false)
        => new("color", location, style, explode, allowReserved);

    private static string Path(ParamStyle style, bool explode, string kind)
    {
        var values = new RequestValues();
        switch (kind)
        {
            case "string": values.Path("color", "blue", TestJson.Default.String); break;
            case "array": values.Path("color", Array, TestJson.Default.ListString); break;
            default: values.Path("color", Object, TestJson.Default.DictionaryStringInt32); break;
        }
        return ParameterSerializer.SerializePath("{color}", [Spec(ParamLocation.Path, style, explode)], values);
    }

    private static string Query(ParamStyle style, bool explode, string kind)
    {
        var values = new RequestValues();
        switch (kind)
        {
            case "string": values.Query("color", "blue", TestJson.Default.String); break;
            case "array": values.Query("color", Array, TestJson.Default.ListString); break;
            default: values.Query("color", Object, TestJson.Default.DictionaryStringInt32); break;
        }
        return ParameterSerializer.SerializeQuery([Spec(ParamLocation.Query, style, explode)], values);
    }

    [Theory]
    [InlineData(ParamStyle.Matrix, false, "string", ";color=blue")]
    [InlineData(ParamStyle.Matrix, false, "array", ";color=blue,black,brown")]
    [InlineData(ParamStyle.Matrix, false, "object", ";color=R,100,G,200,B,150")]
    [InlineData(ParamStyle.Matrix, true, "string", ";color=blue")]
    [InlineData(ParamStyle.Matrix, true, "array", ";color=blue;color=black;color=brown")]
    [InlineData(ParamStyle.Matrix, true, "object", ";R=100;G=200;B=150")]
    [InlineData(ParamStyle.Label, false, "string", ".blue")]
    [InlineData(ParamStyle.Label, false, "array", ".blue,black,brown")]
    [InlineData(ParamStyle.Label, false, "object", ".R,100,G,200,B,150")]
    [InlineData(ParamStyle.Label, true, "string", ".blue")]
    [InlineData(ParamStyle.Label, true, "array", ".blue.black.brown")]
    [InlineData(ParamStyle.Label, true, "object", ".R=100.G=200.B=150")]
    [InlineData(ParamStyle.Simple, false, "string", "blue")]
    [InlineData(ParamStyle.Simple, false, "array", "blue,black,brown")]
    [InlineData(ParamStyle.Simple, false, "object", "R,100,G,200,B,150")]
    [InlineData(ParamStyle.Simple, true, "string", "blue")]
    [InlineData(ParamStyle.Simple, true, "array", "blue,black,brown")]
    [InlineData(ParamStyle.Simple, true, "object", "R=100,G=200,B=150")]
    public void SerializesPathStyles(ParamStyle style, bool explode, string kind, string expected)
        => Assert.Equal(expected, Path(style, explode, kind));

    [Theory]
    [InlineData(ParamStyle.Form, false, "string", "color=blue")]
    [InlineData(ParamStyle.Form, false, "array", "color=blue,black,brown")]
    [InlineData(ParamStyle.Form, false, "object", "color=R,100,G,200,B,150")]
    [InlineData(ParamStyle.Form, true, "string", "color=blue")]
    [InlineData(ParamStyle.Form, true, "array", "color=blue&color=black&color=brown")]
    [InlineData(ParamStyle.Form, true, "object", "R=100&G=200&B=150")]
    [InlineData(ParamStyle.SpaceDelimited, false, "array", "color=blue%20black%20brown")]
    [InlineData(ParamStyle.SpaceDelimited, false, "object", "color=R%20100%20G%20200%20B%20150")]
    [InlineData(ParamStyle.PipeDelimited, false, "array", "color=blue|black|brown")]
    [InlineData(ParamStyle.PipeDelimited, false, "object", "color=R|100|G|200|B|150")]
    [InlineData(ParamStyle.DeepObject, true, "object", "color[R]=100&color[G]=200&color[B]=150")]
    public void SerializesQueryStyles(ParamStyle style, bool explode, string kind, string expected)
        => Assert.Equal(expected, Query(style, explode, kind));

    [Fact]
    public void PercentEncodesReservedCharsInPathValues()
    {
        var spec = new ParamSpec("name", ParamLocation.Path, ParamStyle.Simple, false);
        var values = new RequestValues().Path("name", "a/b?c#d e", TestJson.Default.String);
        Assert.Equal("/files/a%2Fb%3Fc%23d%20e", ParameterSerializer.SerializePath("/files/{name}", [spec], values));
        values = new RequestValues().Path("name", "日本", TestJson.Default.String);
        Assert.Equal("/files/%E6%97%A5%E6%9C%AC", ParameterSerializer.SerializePath("/files/{name}", [spec], values));
    }

    [Fact]
    public void AllowReservedKeepsReservedCharsInQuery()
    {
        var spec = new ParamSpec("reserved", ParamLocation.Query, ParamStyle.Form, true, AllowReserved: true);
        var values = new RequestValues().Query("reserved", "a/b?c:d", TestJson.Default.String);
        Assert.Equal("reserved=a/b?c:d", ParameterSerializer.SerializeQuery([spec], values));
    }

    [Fact]
    public void KeepsEncodeUriComponentSafeChars()
    {
        var spec = new ParamSpec("q", ParamLocation.Query, ParamStyle.Form, true);
        var values = new RequestValues().Query("q", "!'()*~-_.", TestJson.Default.String);
        Assert.Equal("q=!'()*~-_.", ParameterSerializer.SerializeQuery([spec], values));
    }

    [Fact]
    public void SkipsNullValues()
    {
        var specs = new[]
        {
            new ParamSpec("a", ParamLocation.Query, ParamStyle.Form, true),
            new ParamSpec("b", ParamLocation.Query, ParamStyle.Form, true),
            new ParamSpec("c", ParamLocation.Query, ParamStyle.Form, true),
        };
        var values = new RequestValues()
            .Query("a", (int?)null, TestJson.Default.NullableInt32)
            .Query("b", (List<string>?)null, TestJson.Default.ListString)
            .Query("c", ["x", null], TestJson.Default.ListString);
        Assert.Equal("c=x", ParameterSerializer.SerializeQuery(specs, values));
    }

    [Fact]
    public void SerializesEnumStructAndDateTimeOffsetViaJson()
    {
        var specs = new[]
        {
            new ParamSpec("color", ParamLocation.Query, ParamStyle.Form, true),
            new ParamSpec("at", ParamLocation.Query, ParamStyle.Form, true),
            new ParamSpec("flag", ParamLocation.Query, ParamStyle.Form, true),
        };
        var values = new RequestValues()
            .Query("color", new TestColor("sky-blue"), TestJson.Default.TestColor)
            .Query("at", new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero), TestJson.Default.DateTimeOffset)
            .Query("flag", true, TestJson.Default.Boolean);
        Assert.Equal("color=sky-blue&at=2026-10-25T12%3A00%3A00%2B00%3A00&flag=true", ParameterSerializer.SerializeQuery(specs, values));
    }

    [Fact]
    public void SerializeCookieJoinsWithSemicolonSpace()
    {
        var specs = new[]
        {
            new ParamSpec("theme", ParamLocation.Cookie, ParamStyle.Form, true),
            new ParamSpec("tags", ParamLocation.Cookie, ParamStyle.Form, false),
        };
        var values = new RequestValues()
            .Cookie("theme", "dark", TestJson.Default.String)
            .Cookie("tags", ["x", "y"], TestJson.Default.ListString);
        Assert.Equal("theme=dark; tags=x,y", ParameterSerializer.SerializeCookie(specs, values));
        Assert.Null(ParameterSerializer.SerializeCookie(specs, new RequestValues()));
    }

    [Fact]
    public void SerializesHeaderWithoutEncoding()
    {
        var spec = new ParamSpec("X-Ids", ParamLocation.Header, ParamStyle.Simple, false);
        Assert.Equal("a b,c/d", ParameterSerializer.SerializeHeader(spec, Json(["a b", "c/d"])));
    }

    [Theory]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("")]
    public void RejectsDotSegmentPathValue(string value)
    {
        var spec = new ParamSpec("id", ParamLocation.Path, ParamStyle.Simple, false);
        var values = new RequestValues().Path("id", value, TestJson.Default.String);
        Assert.Throws<ArgumentException>(() => ParameterSerializer.SerializePath("/a/{id}", [spec], values));
    }

    [Fact]
    public void RejectsMissingPathParameter()
    {
        var spec = new ParamSpec("id", ParamLocation.Path, ParamStyle.Simple, false);
        Assert.Throws<ArgumentException>(() => ParameterSerializer.SerializePath("/a/{id}", [spec], new RequestValues()));
    }

    [Fact]
    public void RejectsCrLfInHeader()
    {
        var spec = new ParamSpec("X-A", ParamLocation.Header, ParamStyle.Simple, false);
        Assert.Throws<ArgumentException>(() => ParameterSerializer.SerializeHeader(spec, Json(["a\r\nb"])));
    }

    [Fact]
    public void FormEncodingMatchesUrlSearchParams()
    {
        Assert.Equal("a+b%26c", PercentEncoding.Form("a b&c"));
        Assert.Equal("*-._%7E%21%27", PercentEncoding.Form("*-._~!'"));
        Assert.Equal("%E6%97%A5", PercentEncoding.Form("日"));
    }

    private static System.Text.Json.JsonElement Json(List<string> value)
        => System.Text.Json.JsonSerializer.SerializeToElement(value, TestJson.Default.ListString);
}
