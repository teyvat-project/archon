package archon.runtime

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * The parameter values of one call. Values are converted to JSON with their generated serializer,
 * so the parameter serializer sees objects in declaration order and enums as their raw values.
 */
public class RequestValues {
    private val values = HashMap<Pair<ParamLocation, String>, JsonElement>()

    public fun <T> path(name: String, value: T, serializer: KSerializer<T>): RequestValues =
        add(ParamLocation.Path, name, value, serializer)

    public fun <T> query(name: String, value: T, serializer: KSerializer<T>): RequestValues =
        add(ParamLocation.Query, name, value, serializer)

    public fun <T> header(name: String, value: T, serializer: KSerializer<T>): RequestValues =
        add(ParamLocation.Header, name, value, serializer)

    public fun <T> cookie(name: String, value: T, serializer: KSerializer<T>): RequestValues =
        add(ParamLocation.Cookie, name, value, serializer)

    /** The value of a parameter, or `null` when it was not set (or set to null). */
    internal fun get(location: ParamLocation, name: String): JsonElement? = values[location to name]

    private fun <T> add(location: ParamLocation, name: String, value: T, serializer: KSerializer<T>): RequestValues {
        val element = ApiJson.encodeToJsonElement(serializer, value)
        if (element !is JsonNull) values[location to name] = element
        return this
    }
}
