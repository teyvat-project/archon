package archon.runtime

import archon.runtime.TestApi.op
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

class AuthTest {
    private val schemes: Map<String, SecuritySchemeSpec> = mapOf(
        "bearer" to SecuritySchemeSpec.HttpBearer,
        "basic" to SecuritySchemeSpec.HttpBasic,
        "keyHeader" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
        "keyQuery" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
        "keyCookie" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Cookie, "session"),
        "oauth" to SecuritySchemeSpec.OAuth2("/oauth/token"),
    )

    @AfterEach
    fun closeCores() = TestApi.closeCores()

    private fun req(vararg names: String) = SecurityRequirement(names.map { SecurityScheme(it, emptyList()) })

    private fun core(baseUrl: String, auth: Map<String, Any?>, configure: TestOptions.() -> Unit = {}) =
        TestApi.core(baseUrl, schemes) {
            this.auth = AuthConfig { auth[it] }
            configure()
        }

    private suspend fun call(core: ApiClientCore, vararg security: SecurityRequirement): ApiResult<String> =
        core.send(op("/x", responses = TestApi.text, security = security.toList()), RequestValues(), ResponseDecoder.text, ErrorDecoders.None, null)

    @Test
    fun selectorPicksTheFirstSatisfiableAlternative() {
        val none: (String) -> Boolean = { false }
        assertIs<Selection.Anonymous>(SecuritySelector.select(emptyList(), none))
        assertIs<Selection.Anonymous>(SecuritySelector.select(listOf(req("bearer"), req()), none))
        assertEquals(Selection.Missing(listOf("bearer")), SecuritySelector.select(listOf(req("bearer")), none))
        val apply = assertIs<Selection.Apply>(SecuritySelector.select(listOf(req("bearer", "basic"), req("basic")), { it == "basic" }))
        assertEquals(req("basic"), apply.requirement)
        // The missing schemes are those of the first alternative.
        assertEquals(Selection.Missing(listOf("basic")), SecuritySelector.select(listOf(req("bearer", "basic"), req("keyHeader")), { it == "bearer" }))
    }

    @Test
    fun appliesBearerFromSuspendProvider() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val token = TokenValue {
                yield()
                "tok"
            }
            call(core(server.url, mapOf("bearer" to token)), req("bearer"))
            assertEquals("Bearer tok", server.last.header("authorization"))
        }
    }

    @Test
    fun appliesBasicWithUtf8() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            call(core(server.url, mapOf("basic" to BasicValue("user", "päss"))), req("basic"))
            assertEquals("Basic dXNlcjpww6Rzcw==", server.last.header("authorization"))
        }
    }

    @Test
    fun appliesApiKeyInHeaderQueryCookie() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val auth = mapOf("keyHeader" to TokenValue("h"), "keyQuery" to TokenValue("q v"), "keyCookie" to TokenValue("c;d"))
            val core = core(server.url, auth) { headers["Cookie"] = "a=1; session=old" }
            call(core, req("keyHeader", "keyQuery", "keyCookie"))
            assertEquals("h", server.last.header("x-api-key"))
            assertEquals("/x?api_key=q%20v", server.last.target)
            assertEquals("a=1; session=c%3Bd", server.last.header("cookie"))
        }
    }

    @Test
    fun throwsAuthExceptionBeforeSending() = runBlocking<Unit> {
        val sent = AtomicInteger()
        HttpClient(MockEngine { sent.incrementAndGet(); respond("ok") }).use { http ->
            val core = core("http://api.test", mapOf("bearer" to TokenValue("t"))) { httpClient = http }
            val error = assertFailsWith<ApiAuthException> { call(core, req("bearer", "basic")) }
            assertEquals(listOf("basic"), error.schemes)
            assertEquals(0, sent.get())
        }
    }

    @Test
    fun reappliesFreshTokenOnReentry() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            var n = 0
            val core = core(server.url, mapOf("bearer" to TokenValue { "t${++n}" })) {
                middleware.add(Middleware { request, next, _ ->
                    next(request)
                    next(request)
                })
            }
            call(core, req("bearer"))
            assertEquals(listOf("Bearer t1", "Bearer t2"), server.requests.map { it.header("authorization") })
        }
    }

    @Test
    fun retriesOnceOn401WithManagedToken() = runBlocking<Unit> {
        val issued = AtomicInteger()
        TestServer.start {
            when {
                it.target == "/oauth/token" -> TestResponse.json(200, "{\"access_token\":\"at${issued.incrementAndGet()}\",\"expires_in\":3600}")
                it.header("authorization") == "Bearer at2" -> TestResponse(200, "ok")
                else -> TestResponse(401, "no")
            }
        }.use { server ->
            val oauth = OAuth2Value(clientCredentials = OAuth2ClientCredentials("id", "secret"))
            val core = core(server.url, mapOf("oauth" to oauth))
            val result = call(core, SecurityRequirement(listOf(SecurityScheme("oauth", listOf("read")))))
            assertEquals("ok", result.data)
            assertEquals(2, issued.get())
            assertEquals(2, server.requests.count { it.target == "/x" })
            assertEquals("grant_type=client_credentials&scope=read", server.requests.first().bodyText)
        }
    }

    @Test
    fun retries401OnlyOnce() = runBlocking<Unit> {
        val issued = AtomicInteger()
        TestServer.start {
            if (it.target == "/oauth/token") TestResponse.json(200, "{\"access_token\":\"at${issued.incrementAndGet()}\"}") else TestResponse(401, "no")
        }.use { server ->
            val core = core(server.url, mapOf("oauth" to OAuth2Value(clientCredentials = OAuth2ClientCredentials("id", "secret"))))
            val error = assertFailsWith<ApiException> { call(core, req("oauth")) }
            assertEquals(401, error.statusCode)
            assertEquals(2, issued.get())
            assertEquals(listOf("Bearer at1", "Bearer at2"), server.requests.filter { it.target == "/x" }.map { it.header("authorization") })
        }
    }

    @Test
    fun doesNotRetry401ForUnmanagedToken() = runBlocking<Unit> {
        TestServer.start { TestResponse(401, "no") }.use { server ->
            val core = core(server.url, mapOf("oauth" to OAuth2Value(accessToken = TokenValue("static"))))
            assertFailsWith<ApiException> { call(core, req("oauth")) }
            assertEquals(1, server.requests.size)
            assertEquals("Bearer static", server.last.header("authorization"))
        }
    }

    @Test
    fun recreatesManagersWhenTheAuthConfigChanges() = runBlocking<Unit> {
        val issued = AtomicInteger()
        TestServer.start {
            if (it.target == "/oauth/token") TestResponse.json(200, "{\"access_token\":\"at${issued.incrementAndGet()}\"}") else TestResponse(200, "ok")
        }.use { server ->
            val oauth = mapOf("oauth" to OAuth2Value(clientCredentials = OAuth2ClientCredentials("id", "secret")))
            val core = core(server.url, oauth)
            call(core, req("oauth"))
            call(core, req("oauth"))
            assertEquals(1, issued.get())
            (core.options as TestOptions).auth = AuthConfig { oauth[it] }
            call(core, req("oauth"))
            assertEquals(2, issued.get())
            assertEquals("Bearer at2", server.last.header("authorization"))
        }
    }

    @Test
    fun customAuthCoversUnknownScheme() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val core = core(server.url, emptyMap()) { customAuth = { request, _ -> request.headers["Authorization"] = "Digest x" } }
            call(core, req("digest"))
            assertEquals("Digest x", server.last.header("authorization"))
        }
    }

    @Test
    fun unknownSchemeWithoutCustomAuthIsMissing() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val error = assertFailsWith<ApiAuthException> { call(core(server.url, emptyMap()), req("digest")) }
            assertEquals(listOf("digest"), error.schemes)
            assertEquals(0, server.requests.size)
        }
    }
}
