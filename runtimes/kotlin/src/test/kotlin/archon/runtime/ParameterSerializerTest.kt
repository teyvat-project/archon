package archon.runtime

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class ParameterSerializerTest {
    private val colors = listOf("blue", "black", "brown")
    private val rgb = linkedMapOf("R" to 100, "G" to 200, "B" to 150)

    private fun spec(location: ParamLocation, style: ParamStyle, explode: Boolean, allowReserved: Boolean = false) =
        ParamSpec("color", location, style, explode, allowReserved)

    private fun values(location: ParamLocation, kind: String): RequestValues {
        val values = RequestValues()
        return when (kind) {
            "string" -> values.add(location, "blue", String.serializer())
            "array" -> values.add(location, colors, ListSerializer(String.serializer()))
            else -> values.add(location, rgb, MapSerializer(String.serializer(), Int.serializer()))
        }
    }

    private fun <T> RequestValues.add(location: ParamLocation, value: T, serializer: KSerializer<T>) =
        when (location) {
            ParamLocation.Path -> path("color", value, serializer)
            ParamLocation.Query -> query("color", value, serializer)
            ParamLocation.Header -> header("color", value, serializer)
            ParamLocation.Cookie -> cookie("color", value, serializer)
        }

    @ParameterizedTest(name = "{0} explode={1} {2}")
    @MethodSource("pathCases")
    fun serializesPathStyles(style: ParamStyle, explode: Boolean, kind: String, expected: String) {
        val actual = ParameterSerializer.serializePath(
            "{color}",
            listOf(spec(ParamLocation.Path, style, explode)),
            values(ParamLocation.Path, kind),
        )
        assertEquals(expected, actual)
    }

    @ParameterizedTest(name = "{0} explode={1} {2}")
    @MethodSource("queryCases")
    fun serializesQueryStyles(style: ParamStyle, explode: Boolean, kind: String, expected: String) {
        val actual = ParameterSerializer.serializeQuery(
            listOf(spec(ParamLocation.Query, style, explode)),
            values(ParamLocation.Query, kind),
        )
        assertEquals(expected, actual)
    }

    @Test
    fun percentEncodesReservedCharsInPathValues() {
        val spec = ParamSpec("name", ParamLocation.Path, ParamStyle.Simple, false)
        var values = RequestValues().path("name", "a/b?c#d e", String.serializer())
        assertEquals("/files/a%2Fb%3Fc%23d%20e", ParameterSerializer.serializePath("/files/{name}", listOf(spec), values))
        values = RequestValues().path("name", "日本", String.serializer())
        assertEquals("/files/%E6%97%A5%E6%9C%AC", ParameterSerializer.serializePath("/files/{name}", listOf(spec), values))
    }

    @Test
    fun allowReservedKeepsReservedCharsInQuery() {
        val spec = ParamSpec("reserved", ParamLocation.Query, ParamStyle.Form, true, allowReserved = true)
        val values = RequestValues().query("reserved", "a/b?c:d", String.serializer())
        assertEquals("reserved=a/b?c:d", ParameterSerializer.serializeQuery(listOf(spec), values))
    }

    @Test
    fun allowReservedDoesNotApplyToPaths() {
        val spec = ParamSpec("name", ParamLocation.Path, ParamStyle.Simple, false, allowReserved = true)
        val values = RequestValues().path("name", "a/b", String.serializer())
        assertEquals("/files/a%2Fb", ParameterSerializer.serializePath("/files/{name}", listOf(spec), values))
    }

    @Test
    fun keepsEncodeUriComponentSafeChars() {
        val spec = ParamSpec("q", ParamLocation.Query, ParamStyle.Form, true)
        val values = RequestValues().query("q", "!'()*~-_.", String.serializer())
        assertEquals("q=!'()*~-_.", ParameterSerializer.serializeQuery(listOf(spec), values))
    }

    @Test
    fun skipsNullValues() {
        val specs = listOf("a", "b", "c").map { ParamSpec(it, ParamLocation.Query, ParamStyle.Form, true) }
        val values = RequestValues()
            .query("a", null as Int?, Int.serializer().nullable)
            .query("b", null as List<String>?, ListSerializer(String.serializer()).nullable)
            .query("c", listOf("x", null), ListSerializer(String.serializer().nullable))
        assertEquals("c=x", ParameterSerializer.serializeQuery(specs, values))
    }

    @Test
    fun serializesNumbersAndBooleansAsLiterals() {
        val specs = listOf("n", "f", "b").map { ParamSpec(it, ParamLocation.Query, ParamStyle.Form, true) }
        val values = RequestValues()
            .query("n", 42, Int.serializer())
            .query("f", 1.5, Double.serializer())
            .query("b", true, Boolean.serializer())
        assertEquals("n=42&f=1.5&b=true", ParameterSerializer.serializeQuery(specs, values))
    }

    @Test
    fun serializeCookieJoinsWithSemicolonSpace() {
        val specs = listOf(
            ParamSpec("theme", ParamLocation.Cookie, ParamStyle.Form, true),
            ParamSpec("tags", ParamLocation.Cookie, ParamStyle.Form, false),
        )
        val values = RequestValues()
            .cookie("theme", "dark", String.serializer())
            .cookie("tags", listOf("x", "y"), ListSerializer(String.serializer()))
        assertEquals("theme=dark; tags=x,y", ParameterSerializer.serializeCookie(specs, values))
        assertNull(ParameterSerializer.serializeCookie(specs, RequestValues()))
    }

    @Test
    fun serializesHeaderWithoutEncoding() {
        val spec = ParamSpec("X-Ids", ParamLocation.Header, ParamStyle.Simple, false)
        assertEquals("a b,c/d", ParameterSerializer.serializeHeader(spec, JsonArray(listOf(JsonPrimitive("a b"), JsonPrimitive("c/d")))))
    }

    @ParameterizedTest
    @MethodSource("dotSegments")
    fun rejectsDotSegmentPathValue(value: String) {
        val spec = ParamSpec("id", ParamLocation.Path, ParamStyle.Simple, false)
        val values = RequestValues().path("id", value, String.serializer())
        assertFailsWith<IllegalArgumentException> { ParameterSerializer.serializePath("/a/{id}", listOf(spec), values) }
    }

    @Test
    fun rejectsMissingPathParameter() {
        val spec = ParamSpec("id", ParamLocation.Path, ParamStyle.Simple, false)
        assertFailsWith<IllegalArgumentException> { ParameterSerializer.serializePath("/a/{id}", listOf(spec), RequestValues()) }
    }

    @Test
    fun rejectsCrLfInHeader() {
        val spec = ParamSpec("X-A", ParamLocation.Header, ParamStyle.Simple, false)
        assertFailsWith<IllegalArgumentException> {
            ParameterSerializer.serializeHeader(spec, JsonArray(listOf(JsonPrimitive("a\r\nb"))))
        }
    }

    @Test
    fun formEncodingMatchesUrlSearchParams() {
        assertEquals("a+b%26c", PercentEncoding.form("a b&c"))
        assertEquals("*-._%7E%21%27", PercentEncoding.form("*-._~!'"))
        assertEquals("%E6%97%A5", PercentEncoding.form("日"))
    }

    @Test
    fun encodesSurrogatePairsAsFourByteUtf8() {
        assertEquals("%F0%9F%98%80", PercentEncoding.component("😀"))
    }

    @Test
    fun encodesLoneSurrogateAsReplacementChar() {
        assertEquals("%EF%BF%BD", PercentEncoding.component("\uD800"))
        assertEquals("a%EF%BF%BDb", PercentEncoding.component("a\uDC00b"))
    }

    companion object {
        @JvmStatic
        fun pathCases(): List<Arguments> = listOf(
            Arguments.of(ParamStyle.Matrix, false, "string", ";color=blue"),
            Arguments.of(ParamStyle.Matrix, false, "array", ";color=blue,black,brown"),
            Arguments.of(ParamStyle.Matrix, false, "object", ";color=R,100,G,200,B,150"),
            Arguments.of(ParamStyle.Matrix, true, "string", ";color=blue"),
            Arguments.of(ParamStyle.Matrix, true, "array", ";color=blue;color=black;color=brown"),
            Arguments.of(ParamStyle.Matrix, true, "object", ";R=100;G=200;B=150"),
            Arguments.of(ParamStyle.Label, false, "string", ".blue"),
            Arguments.of(ParamStyle.Label, false, "array", ".blue,black,brown"),
            Arguments.of(ParamStyle.Label, false, "object", ".R,100,G,200,B,150"),
            Arguments.of(ParamStyle.Label, true, "string", ".blue"),
            Arguments.of(ParamStyle.Label, true, "array", ".blue.black.brown"),
            Arguments.of(ParamStyle.Label, true, "object", ".R=100.G=200.B=150"),
            Arguments.of(ParamStyle.Simple, false, "string", "blue"),
            Arguments.of(ParamStyle.Simple, false, "array", "blue,black,brown"),
            Arguments.of(ParamStyle.Simple, false, "object", "R,100,G,200,B,150"),
            Arguments.of(ParamStyle.Simple, true, "string", "blue"),
            Arguments.of(ParamStyle.Simple, true, "array", "blue,black,brown"),
            Arguments.of(ParamStyle.Simple, true, "object", "R=100,G=200,B=150"),
        )

        @JvmStatic
        fun queryCases(): List<Arguments> = listOf(
            Arguments.of(ParamStyle.Form, false, "string", "color=blue"),
            Arguments.of(ParamStyle.Form, false, "array", "color=blue,black,brown"),
            Arguments.of(ParamStyle.Form, false, "object", "color=R,100,G,200,B,150"),
            Arguments.of(ParamStyle.Form, true, "string", "color=blue"),
            Arguments.of(ParamStyle.Form, true, "array", "color=blue&color=black&color=brown"),
            Arguments.of(ParamStyle.Form, true, "object", "R=100&G=200&B=150"),
            Arguments.of(ParamStyle.SpaceDelimited, false, "array", "color=blue%20black%20brown"),
            Arguments.of(ParamStyle.SpaceDelimited, false, "object", "color=R%20100%20G%20200%20B%20150"),
            Arguments.of(ParamStyle.PipeDelimited, false, "array", "color=blue|black|brown"),
            Arguments.of(ParamStyle.PipeDelimited, false, "object", "color=R|100|G|200|B|150"),
            Arguments.of(ParamStyle.DeepObject, true, "object", "color[R]=100&color[G]=200&color[B]=150"),
        )

        @JvmStatic
        fun dotSegments(): List<String> = listOf(".", "..", "")
    }
}
