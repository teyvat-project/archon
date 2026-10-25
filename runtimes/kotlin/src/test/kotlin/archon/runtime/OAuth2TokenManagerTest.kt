package archon.runtime

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds

class OAuth2TokenManagerTest {
    /** A token request as the mock engine saw it. */
    class SeenRequest(val method: String, val url: String, val headers: Map<String, String>, val contentType: String?, val body: String) {
        fun header(name: String): String? = headers[name.lowercase()]
    }

    /** A token endpoint issuing `at1`, `at2`, ...; [gate] holds every response until it completes. */
    class TokenEndpoint(
        expiresIn: Int = 3600,
        status: Int = 200,
        refreshToken: String? = null,
        body: String? = null,
        gate: CompletableDeferred<Unit>? = null,
    ) {
        val seen = ConcurrentLinkedQueue<SeenRequest>()
        private val issued = AtomicInteger()

        val http = HttpClient(MockEngine { request ->
            val headers = request.headers.entries().associate { (name, values) -> name.lowercase() to values.joinToString(", ") }
            seen.add(SeenRequest(request.method.value, request.url.toString(), headers, request.body.contentType?.toString(), request.body.toByteArray().decodeToString()))
            gate?.await()
            val refresh = refreshToken?.let { ",\"refresh_token\":\"$it\"" }.orEmpty()
            val text = body ?: "{\"access_token\":\"at${issued.incrementAndGet()}\",\"expires_in\":$expiresIn$refresh}"
            respond(text, HttpStatusCode.fromValue(status), headersOf(HttpHeaders.ContentType, "application/json"))
        })
    }

    private val endpoints = ArrayList<TokenEndpoint>()

    @AfterEach
    fun closeClients() = endpoints.forEach { it.http.close() }

    private fun endpoint(
        expiresIn: Int = 3600,
        status: Int = 200,
        refreshToken: String? = null,
        body: String? = null,
        gate: CompletableDeferred<Unit>? = null,
    ) = TokenEndpoint(expiresIn, status, refreshToken, body, gate).also { endpoints.add(it) }

    private fun clientCredentials(vararg scopes: String) =
        OAuth2Value(clientCredentials = OAuth2ClientCredentials("client-id", "client-secret", scopes.toList()))

    private val tokenUrl = "http://auth.test/token"

    @Test
    fun fetchesClientCredentialsWithBasicClientAuth() = runBlocking<Unit> {
        val endpoint = endpoint()
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials("write"), tokenUrl, null, "oauth2")
        assertTrue(manager.managed)
        assertEquals("at1", manager.getToken(listOf("read")))
        val request = endpoint.seen.single()
        assertEquals("POST", request.method)
        assertEquals(tokenUrl, request.url)
        assertEquals("application/x-www-form-urlencoded", request.contentType)
        assertEquals("application/json", request.header("accept"))
        assertEquals("Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=", request.header("authorization"))
        assertEquals("grant_type=client_credentials&scope=read+write", request.body)
    }

    @Test
    fun postClientAuthPutsCredentialsInTheForm() = runBlocking<Unit> {
        val endpoint = endpoint()
        val config = OAuth2Value(clientCredentials = OAuth2ClientCredentials("id", "s", clientAuth = OAuth2ClientAuth.Post))
        OAuth2TokenManager(endpoint.http, config, tokenUrl, null, "oauth2").getToken(emptyList())
        val request = endpoint.seen.single()
        assertEquals("grant_type=client_credentials&client_id=id&client_secret=s", request.body)
        assertNull(request.header("authorization"))
    }

    @Test
    fun cachesUntil30sBeforeExpiry() = runBlocking<Unit> {
        val endpoint = endpoint(expiresIn = 60)
        var now = 1_000_000L
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2", nowMillis = { now })
        assertEquals("at1", manager.getToken(emptyList()))
        now += 29_000
        assertEquals("at1", manager.getToken(emptyList()))
        now += 1_000
        assertEquals("at2", manager.getToken(emptyList()))
        assertEquals(2, endpoint.seen.size)
    }

    @Test
    fun cachesPerScopeSetInSortedUnion() = runBlocking<Unit> {
        val endpoint = endpoint()
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials("b"), tokenUrl, null, "oauth2")
        assertEquals("at1", manager.getToken(listOf("c", "a", "b")))
        assertEquals("at1", manager.getToken(listOf("a", "c")))
        assertEquals("at2", manager.getToken(listOf("a")))
        assertEquals(listOf("grant_type=client_credentials&scope=a+b+c", "grant_type=client_credentials&scope=a+b"), endpoint.seen.map { it.body })
    }

    @Test
    fun singleFlightForConcurrentCalls() = runBlocking<Unit> {
        val gate = CompletableDeferred<Unit>()
        val endpoint = endpoint(gate = gate)
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2")
        // UNDISPATCHED: each caller runs until it waits on the shared fetch before the next one starts.
        val callers = List(5) { async(start = CoroutineStart.UNDISPATCHED) { manager.getToken(emptyList()) } }
        gate.complete(Unit)
        assertEquals(List(5) { "at1" }, callers.awaitAll())
        assertEquals(1, endpoint.seen.size)
    }

    @Test
    fun cancelledWaiterDoesNotCancelSharedFetch() = runBlocking<Unit> {
        val gate = CompletableDeferred<Unit>()
        val endpoint = endpoint(gate = gate)
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2")
        val callers = List(5) { async(start = CoroutineStart.UNDISPATCHED) { manager.getToken(emptyList()) } }
        callers[0].cancel()
        callers[0].join()
        gate.complete(Unit)
        assertFailsWith<CancellationException> { callers[0].await() }
        assertEquals(List(4) { "at1" }, callers.drop(1).awaitAll())
        assertEquals(1, endpoint.seen.size)
        // The cancelled caller's fetch was cached for later calls too.
        assertEquals("at1", manager.getToken(emptyList()))
    }

    @Test
    fun failedFetchIsNotSharedWithLaterCalls() = runBlocking<Unit> {
        val failing = endpoint(status = 500)
        val manager = OAuth2TokenManager(failing.http, clientCredentials(), tokenUrl, null, "oauth2")
        assertFailsWith<ApiAuthException> { manager.getToken(emptyList()) }
        assertFailsWith<ApiAuthException> { manager.getToken(emptyList()) }
        assertEquals(2, failing.seen.size)
    }

    @Test
    fun refreshGrantRotatesTokenAndCallsOnRefreshed() = runBlocking<Unit> {
        val endpoint = endpoint(expiresIn = 1, refreshToken = "rt-new")
        val refreshed = ArrayList<TokenSet>()
        val config = OAuth2Value(
            refreshToken = OAuth2RefreshToken("rt-old", "id", "s", onRefreshed = { refreshed.add(it) }),
        )
        val manager = OAuth2TokenManager(endpoint.http, config, tokenUrl, null, "oauth2", nowMillis = { 5_000 })
        assertEquals("at1", manager.getToken(listOf("read")))
        // expires_in 1 < leeway: fetched again (the cache key ignores scopes), with the rotated token.
        assertEquals("at2", manager.getToken(emptyList()))
        assertEquals(
            listOf("grant_type=refresh_token&refresh_token=rt-old", "grant_type=refresh_token&refresh_token=rt-new"),
            endpoint.seen.map { it.body },
        )
        assertEquals("Basic aWQ6cw==", endpoint.seen.first().header("authorization"))
        assertEquals(2, refreshed.size)
        assertEquals(TokenSet("at1", "rt-new", 6_000, null), refreshed[0])
    }

    @Test
    fun refreshGrantWithoutSecretSendsClientIdInTheForm() = runBlocking<Unit> {
        val endpoint = endpoint()
        val config = OAuth2Value(refreshToken = OAuth2RefreshToken("rt", "id"))
        OAuth2TokenManager(endpoint.http, config, tokenUrl, null, "oauth2").getToken(emptyList())
        val request = endpoint.seen.single()
        assertEquals("grant_type=refresh_token&refresh_token=rt&client_id=id", request.body)
        assertNull(request.header("authorization"))
    }

    @Test
    fun readsExpiresInWrittenAsAString() = runBlocking<Unit> {
        val endpoint = endpoint(body = "{\"access_token\":\"t\",\"expires_in\":\"90\"}")
        var now = 0L
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2", nowMillis = { now })
        assertEquals("t", manager.getToken(emptyList()))
        now = 59_999
        manager.getToken(emptyList())
        assertEquals(1, endpoint.seen.size)
        now = 60_000
        manager.getToken(emptyList())
        assertEquals(2, endpoint.seen.size)
    }

    @Test
    fun resolvesRelativeTokenUrlAgainstBaseUrl() = runBlocking<Unit> {
        val endpoint = endpoint()
        OAuth2TokenManager(endpoint.http, clientCredentials(), "/oauth/token", "http://api.test/v1/", "oauth2").getToken(emptyList())
        assertEquals("http://api.test/oauth/token", endpoint.seen.last().url)
        // The configured URL wins over the spec's.
        val configured = OAuth2Value(clientCredentials = OAuth2ClientCredentials("id", "s", tokenUrl = "token"))
        OAuth2TokenManager(endpoint.http, configured, "/oauth/token", "http://api.test/v1/", "oauth2").getToken(emptyList())
        assertEquals("http://api.test/v1/token", endpoint.seen.last().url)
    }

    @Test
    fun authExceptionOnTokenEndpointFailure() = runBlocking<Unit> {
        for (failing in listOf(endpoint(status = 401), endpoint(body = "not json"), endpoint(body = "{\"token_type\":\"bearer\"}"), endpoint(body = "[]"))) {
            val manager = OAuth2TokenManager(failing.http, clientCredentials(), tokenUrl, null, "oauth2")
            val error = assertFailsWith<ApiAuthException> { manager.getToken(emptyList()) }
            assertEquals(listOf("oauth2"), error.schemes)
        }
        val http = endpoint().http
        assertFailsWith<ApiAuthException> { OAuth2TokenManager(http, clientCredentials(), null, null, "oauth2").getToken(emptyList()) }
        assertFailsWith<ApiAuthException> { OAuth2TokenManager(http, clientCredentials(), "/token", null, "oauth2").getToken(emptyList()) }
        assertFailsWith<ApiAuthException> { OAuth2TokenManager(http, OAuth2Value(), tokenUrl, null, "oauth2").getToken(emptyList()) }
    }

    @Test
    fun timeoutIsAnAuthException() = runBlocking<Unit> {
        val endpoint = endpoint(gate = CompletableDeferred())
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2", timeout = 50.milliseconds)
        val error = assertFailsWith<ApiAuthException> { manager.getToken(emptyList()) }
        assertEquals(listOf("oauth2"), error.schemes)
    }

    @Test
    fun invalidateOnlyDropsTheRejectedToken() = runBlocking<Unit> {
        val endpoint = endpoint()
        val manager = OAuth2TokenManager(endpoint.http, clientCredentials(), tokenUrl, null, "oauth2")
        manager.getToken(emptyList())
        manager.invalidate("stale")
        assertEquals("at1", manager.getToken(emptyList()))
        manager.invalidate("at1")
        assertEquals("at2", manager.getToken(emptyList()))
        manager.invalidate()
        assertEquals("at3", manager.getToken(emptyList()))
    }
}
