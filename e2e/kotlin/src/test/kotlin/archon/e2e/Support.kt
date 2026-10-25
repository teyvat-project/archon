package archon.e2e

import archon.edgecases.ApiClient
import archon.edgecases.ApiClientOptions
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The mock server's counters: tokens issued and requests per raw path. */
data class Stats(val tokensIssued: Int, val requests: Map<String, Int>)

object Env {
    val baseUrl: String get() = property("archon.e2e.baseUrl")

    val secondaryUrl: String get() = property("archon.e2e.secondaryUrl")

    /** One engine for every test; each SDK client derives its own configuration from it. */
    val http: HttpClient by lazy { HttpClient(CIO) }

    fun client(configure: ApiClientOptions.() -> Unit = {}): ApiClient = ApiClient {
        baseUrl = Env.baseUrl
        httpClient = http
        configure()
    }

    suspend fun stats(): Stats {
        val root = Json.parseToJsonElement(http.get("$baseUrl/__stats").bodyAsText()).jsonObject
        val requests = root.getValue("requests").jsonObject.mapValues { it.value.jsonPrimitive.int }
        return Stats(root.getValue("tokensIssued").jsonPrimitive.int, requests)
    }

    suspend fun requestCount(path: String): Int = stats().requests[path] ?: 0

    private fun property(name: String): String =
        System.getProperty(name)?.takeIf { it.isNotEmpty() } ?: error("$name is not set; run the suite with `pnpm test:e2e:kotlin`.")
}
