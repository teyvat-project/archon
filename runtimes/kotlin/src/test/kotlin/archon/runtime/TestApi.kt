package archon.runtime

import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.engine.cio.CIO
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable

@Serializable
data class TestPet(val name: String, val count: Int? = null)

@Serializable
data class TestProblem(val message: String)

@Serializable
data class TestForm(val name: String, val count: Int, val tags: List<String>, val meta: Map<String, Int>? = null)

class TestOptions : ClientOptions() {
    var auth: AuthConfig? = null

    override val authConfig: AuthConfig? get() = auth
}

object TestApi {
    val noSchemes: Map<String, SecuritySchemeSpec> = emptyMap()

    /** The engines every engine-dependent test runs on. */
    @JvmStatic
    fun engines(): List<String> = listOf("CIO", "OkHttp", "Android")

    fun client(engine: String, block: io.ktor.client.HttpClientConfig<*>.() -> Unit = {}): HttpClient = when (engine) {
        "CIO" -> HttpClient(CIO, block)
        "OkHttp" -> HttpClient(OkHttp, block)
        "Android" -> HttpClient(Android, block)
        else -> error("unknown engine $engine")
    }

    fun core(
        baseUrl: String,
        schemes: Map<String, SecuritySchemeSpec> = noSchemes,
        configure: TestOptions.() -> Unit = {},
    ): ApiClientCore {
        val options = TestOptions().apply { this.baseUrl = baseUrl }
        options.configure()
        return ApiClientCore(options, schemes)
    }

    fun op(
        path: String,
        method: HttpMethod = HttpMethod.Get,
        params: List<ParamSpec> = emptyList(),
        body: BodyKind? = null,
        mediaType: String? = null,
        responses: Map<String, ResponseKind> = mapOf("200" to ResponseKind.Json),
        security: List<SecurityRequirement> = emptyList(),
    ) = OperationSpec("testOp", method, path, listOf("test"), security, params, body, mediaType, responses)

    fun q(name: String, explode: Boolean = true) = ParamSpec(name, ParamLocation.Query, ParamStyle.Form, explode)

    fun p(name: String) = ParamSpec(name, ParamLocation.Path, ParamStyle.Simple, false)

    val text: Map<String, ResponseKind> = mapOf("200" to ResponseKind.Text)
}
