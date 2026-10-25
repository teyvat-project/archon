using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Archon.Runtime;

/// <summary>
/// The parameter values (and the body) of one call. Values are converted to JSON with their source-generated
/// type information, so the serializer sees objects in declaration order and enums as their raw values.
/// </summary>
public sealed partial class RequestValues
{
    private readonly Dictionary<(ParamLocation, string), JsonElement> _values = [];

    public RequestValues Path<T>(string name, T value, JsonTypeInfo<T> info) => Add(ParamLocation.Path, name, value, info);

    public RequestValues Query<T>(string name, T value, JsonTypeInfo<T> info) => Add(ParamLocation.Query, name, value, info);

    public RequestValues Header<T>(string name, T value, JsonTypeInfo<T> info) => Add(ParamLocation.Header, name, value, info);

    public RequestValues Cookie<T>(string name, T value, JsonTypeInfo<T> info) => Add(ParamLocation.Cookie, name, value, info);

    /// <summary>The value of a parameter, or <c>null</c> when it was not set (or set to null).</summary>
    public JsonElement? Get(ParamLocation location, string name)
        => _values.TryGetValue((location, name), out var value) ? value : null;

    private RequestValues Add<T>(ParamLocation location, string name, T value, JsonTypeInfo<T> info)
    {
        ArgumentNullException.ThrowIfNull(info);
        if (value is null) return this;
        var element = JsonSerializer.SerializeToElement(value, info);
        if (element.ValueKind != JsonValueKind.Null) _values[(location, name)] = element;
        return this;
    }
}
