package archon.runtime

import archon.runtime.TestApi.op
import io.ktor.http.HttpMethod
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class StandardMiddlewareTest {
    @AfterEach
    fun closeCores() = TestApi.closeCores()

    private suspend fun get(core: ApiClientCore, operation: OperationSpec = op("/x", responses = TestApi.text), values: RequestValues = RequestValues()): ApiResult<String> =
        core.send(operation, values, ResponseDecoder.text, ErrorDecoders.None, null)

    private fun flaky(failures: Int, status: Int = 503, headers: Map<String, String> = emptyMap()): TestServer {
        val n = AtomicInteger()
        return TestServer.start { if (n.incrementAndGet() <= failures) TestResponse(status, "busy", headers) else TestResponse(200, "ok") }
    }

    private val noDelay: suspend (Duration) -> Unit = {}

    /** A terminal-like middleware that answers without the network. */
    private fun answer(block: (ApiRequest) -> ApiResponse) = Middleware { request, _, _ -> block(request) }

    private fun ok(request: ApiRequest) = ApiResponse(200, ApiHeaders(), request.url, "ok".encodeToByteArray())

    @Test
    fun retries503WithRetryAfterSeconds() = runBlocking<Unit> {
        flaky(1, headers = mapOf("Retry-After" to "1")).use { server ->
            val delays = mutableListOf<Duration>()
            val attempts = mutableListOf<Int>()
            val core = TestApi.core(server.url) {
                middleware.add(RetryMiddleware(delay = { delays.add(it) }))
                middleware.add(Middleware { request, next, context ->
                    attempts.add(context.attempt)
                    next(request)
                })
            }
            assertEquals("ok", get(core).data)
            assertEquals(listOf(1.seconds), delays)
            assertEquals(listOf(1, 2), attempts)
        }
    }

    @Test
    fun retries429WithRetryAfterHttpDate() = runBlocking<Unit> {
        flaky(1, status = 429, headers = mapOf("Retry-After" to "Sun, 25 Oct 2026 12:00:05 GMT")).use { server ->
            val now = java.time.Instant.parse("2026-10-25T12:00:00Z").toEpochMilli()
            val delays = mutableListOf<Duration>()
            val core = TestApi.core(server.url) {
                middleware.add(RetryMiddleware(delay = { delays.add(it) }, nowMillis = { now }))
            }
            assertEquals("ok", get(core).data)
            assertEquals(listOf(5.seconds), delays)
        }
    }

    @Test
    fun retryAfterIsCappedAndPastDatesWaitZero() = runBlocking<Unit> {
        val now = java.time.Instant.parse("2026-10-25T12:00:00Z").toEpochMilli()
        val delays = mutableListOf<Duration>()
        val values = ArrayDeque(listOf("120", "Sun, 25 Oct 2026 11:00:00 GMT", "Wed, 21 Oct 2026 07:28:00 GMT trailing", ""))
        val retry = RetryMiddleware(maxAttempts = 5, delay = { delays.add(it) }, nowMillis = { now }, random = { 0.0 })
        val core = TestApi.core("http://127.0.0.1:1") {
            middleware.add(retry)
            middleware.add(answer { request ->
                val value = values.removeFirstOrNull()
                if (value == null) ok(request) else ApiResponse(503, ApiHeaders(mapOf("Retry-After" to value)), request.url, ByteArray(0))
            })
        }
        assertEquals("ok", get(core).data)
        // 120 s capped at 60 s; a past date waits 0; malformed and empty values fall back to the backoff (attempts 3 and 4).
        assertEquals(listOf(60.seconds, Duration.ZERO, 400.milliseconds, 800.milliseconds), delays)
    }

    @Test
    fun doesNotRetryPostByDefault() = runBlocking<Unit> {
        flaky(1).use { server ->
            val core = TestApi.core(server.url) { middleware.add(RetryMiddleware(delay = noDelay)) }
            assertFailsWith<ApiException> { get(core, op("/x", HttpMethod.Post, responses = TestApi.text)) }
            assertEquals(1, server.requests.size)
        }
    }

    @Test
    fun doesNotRetryNonReplayable() = runBlocking<Unit> {
        flaky(1).use { server ->
            val core = TestApi.core(server.url) { middleware.add(RetryMiddleware(delay = noDelay)) }
            val operation = op("/x", HttpMethod.Put, body = BodyKind.Binary, mediaType = "application/octet-stream", responses = TestApi.text)
            val values = RequestValues().body(ChannelBody(ByteReadChannel(byteArrayOf(1, 2, 3)), "application/octet-stream"))
            assertFailsWith<ApiException> { get(core, operation, values) }
            assertEquals(1, server.requests.size)
        }
    }

    @Test
    fun stopsAfterMaxAttempts() = runBlocking<Unit> {
        flaky(10).use { server ->
            val core = TestApi.core(server.url) { middleware.add(RetryMiddleware(maxAttempts = 2, delay = noDelay)) }
            val error = assertFailsWith<ApiException> { get(core) }
            assertEquals(503, error.statusCode)
            assertEquals(2, server.requests.size)
        }
    }

    @Test
    fun retriesNetworkErrorsButNotTimeouts() = runBlocking<Unit> {
        var calls = 0
        val core = TestApi.core("http://127.0.0.1:1") {
            middleware.add(RetryMiddleware(delay = noDelay))
            middleware.add(answer { request ->
                if (++calls < 3) throw ApiTransportException("boom")
                ok(request)
            })
        }
        assertEquals("ok", get(core).data)
        assertEquals(3, calls)

        var timeouts = 0
        val slow = TestApi.core("http://127.0.0.1:1") {
            middleware.add(RetryMiddleware(delay = noDelay))
            middleware.add(answer {
                timeouts++
                throw ApiTransportException("slow", timedOut = true)
            })
        }
        assertTrue(assertFailsWith<ApiTransportException> { get(slow) }.timedOut)
        assertEquals(1, timeouts)

        var off = 0
        val disabled = TestApi.core("http://127.0.0.1:1") {
            middleware.add(RetryMiddleware(retryOnNetworkError = false, delay = noDelay))
            middleware.add(answer {
                off++
                throw ApiTransportException("boom")
            })
        }
        assertFailsWith<ApiTransportException> { get(disabled) }
        assertEquals(1, off)
    }

    @Test
    fun doesNotRetryCancellation() = runBlocking<Unit> {
        var calls = 0
        val core = TestApi.core("http://127.0.0.1:1") {
            middleware.add(RetryMiddleware(delay = noDelay))
            middleware.add(answer {
                calls++
                throw kotlinx.coroutines.CancellationException("stop")
            })
        }
        assertFailsWith<kotlinx.coroutines.CancellationException> { get(core) }
        assertEquals(1, calls)
    }

    @ParameterizedTest
    @CsvSource("0.0, 1, 100", "1.0, 1, 200", "0.0, 3, 400", "1.0, 10, 5000")
    fun equalJitterBounds(random: Double, attempt: Int, expectedMs: Long) {
        assertEquals(expectedMs.milliseconds, RetryMiddleware(random = { random }).backoff(attempt))
    }

    @Test
    fun retry401RetriesOnceWithFreshAuth() = runBlocking<Unit> {
        TestServer.start { if (it.header("authorization") == "Bearer good") TestResponse(200, "ok") else TestResponse(401, "no") }.use { server ->
            var token = "expired"
            val seenAttempts = mutableListOf<Int>()
            val schemes = mapOf<String, SecuritySchemeSpec>("bearer" to SecuritySchemeSpec.HttpBearer)
            val bearer = TokenValue { token }
            val core = TestApi.core(server.url, schemes) {
                auth = AuthConfig { if (it == "bearer") bearer else null }
                middleware.add(Retry401Middleware { context, _ ->
                    seenAttempts.add(context.attempt)
                    token = "good"
                    true
                })
            }
            val operation = op("/x", responses = TestApi.text, security = listOf(SecurityRequirement(listOf(SecurityScheme("bearer", emptyList())))))
            assertEquals("ok", get(core, operation).data)
            assertEquals(listOf(1), seenAttempts)
            assertEquals(listOf("Bearer expired", "Bearer good"), server.requests.map { it.header("authorization") })
        }
    }

    @Test
    fun retry401LeavesTheResponseWhenTheCallbackDeclines() = runBlocking<Unit> {
        TestServer.start { TestResponse(401, "no") }.use { server ->
            val core = TestApi.core(server.url) { middleware.add(Retry401Middleware { _, _ -> false }) }
            assertEquals(401, assertFailsWith<ApiException> { get(core) }.statusCode)
            assertEquals(1, server.requests.size)
        }
    }

    @Test
    fun loggingMasksAuthorizationCookieAndApiKeyQuery() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val lines = mutableListOf<String>()
            val schemes = mapOf(
                "keyHeader" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
                "keyQuery" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
            )
            val core = TestApi.core(server.url, schemes) {
                headers["Authorization"] = "Bearer secret-token"
                headers["X-API-Key"] = "secret-key"
                headers["Cookie"] = "theme=dark"
                headers["X-Custom"] = "visible"
                headers["X-Custom-Secret"] = "secret-custom"
                middleware.add(Middleware { request, next, _ ->
                    request.setQueryParameter("api_key", "secret-key")
                    request.setQueryParameter("token", "secret-q")
                    next(request)
                })
                middleware.add(LoggingMiddleware(log = { lines.add(it) }, includeHeaders = true, redactHeaders = setOf("x-custom-secret"), redactQuery = setOf("TOKEN")))
            }
            get(core, op("/echo", responses = TestApi.text))

            val all = lines.joinToString("\n")
            assertEquals("→ GET ${server.url}/echo?api_key=***&token=***", lines[0])
            assertContains(lines, "  Authorization: ***")
            assertContains(lines, "  X-API-Key: ***")
            assertContains(lines, "  Cookie: ***")
            assertContains(lines, "  X-Custom-Secret: ***")
            assertContains(lines, "  X-Custom: visible")
            assertFalse("secret" in all)
            assertFalse("dark" in all)
            assertTrue(Regex("^← 200 \\(\\d+ms\\)$").matches(lines.last()), lines.last())
        }
    }

    @Test
    fun userAgentSetsHeader() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val core = TestApi.core(server.url) { middleware.add(UserAgentMiddleware("archon-test/1.0")) }
            get(core)
            assertEquals("archon-test/1.0", server.last.header("user-agent"))
        }
    }
}
