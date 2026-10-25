package archon.e2e

import archon.edgecases.ApiAuth
import archon.edgecases.core.ApiException
import archon.edgecases.core.LoggingMiddleware
import archon.edgecases.core.Middleware
import archon.edgecases.core.Retry401Middleware
import archon.edgecases.core.RetryMiddleware
import archon.edgecases.core.TokenValue
import archon.edgecases.core.UserAgentMiddleware
import archon.edgecases.core.bodyAs
import archon.edgecases.models.Error
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MiddlewareTest {
    @Test
    fun retries503ResponsesUntilTheEndpointSucceeds() = runBlocking<Unit> {
        val client = Env.client { middleware.add(RetryMiddleware()) }
        val key = "retry-${UUID.randomUUID()}"
        val data = client.middleware.flaky(key, fail = 2)
        assertEquals(key to 3, data.key to data.attempts)
    }

    @Test
    fun givesUpAfterMaxAttemptsAndThrowsTheTyped503() = runBlocking<Unit> {
        val client = Env.client { middleware.add(RetryMiddleware(maxAttempts = 2)) }
        val error = assertFailsWith<ApiException> { client.middleware.flaky("give-up-${UUID.randomUUID()}", fail = 5) }
        assertEquals(503, error.statusCode)
        assertEquals(503, error.bodyAs<Error>()!!.code)
    }

    @Test
    fun reSendsOnceAfterA401WhenTheTokenWasSwappedByRetry401() = runBlocking<Unit> {
        var token = "expired-token"
        val swaps = mutableListOf<Int>()
        val client = Env.client {
            auth = ApiAuth(bearerAuth = TokenValue { token })
            middleware.add(
                Retry401Middleware { context, _ ->
                    swaps.add(context.attempt)
                    token = "test-token"
                    true
                },
            )
        }
        assertEquals("Bearer test-token", client.auth.authBearer().headers["authorization"])
        assertEquals(listOf(1), swaps)
    }

    @Test
    fun masksCredentialsInLogs() = runBlocking<Unit> {
        val lines = mutableListOf<String>()
        // Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
        val withQueryKey = Middleware { request, next, _ ->
            request.setQueryParameter("api_key", "test-key")
            next(request)
        }
        val client = Env.client {
            headers["Authorization"] = "Bearer test-token"
            headers["X-API-Key"] = "test-key"
            middleware.add(withQueryKey)
            middleware.add(LoggingMiddleware(log = { lines.add(it) }, includeHeaders = true))
        }
        val echo = client.echo.echoHeadersCookies(listOf("r1"), "dark")
        // The server did receive the credentials...
        assertEquals("Bearer test-token", echo.headers["authorization"])
        assertEquals("test-key", echo.headers["x-api-key"])
        assertEquals("api_key=test-key", echo.query)

        // ...but the log did not.
        val logged = lines.joinToString("\n")
        assertFalse("test-token" in logged)
        assertFalse("test-key" in logged)
        assertFalse("dark" in logged)
        assertEquals("→ GET ${Env.baseUrl}/echo/headers?api_key=***", lines.first())
        val headers = lines.drop(1).dropLast(1).map { it.trim().lowercase() }
        assertContains(headers, "authorization: ***")
        assertContains(headers, "x-api-key: ***")
        assertContains(headers, "cookie: ***")
        assertContains(headers, "x-request-ids: r1")
        assertTrue(Regex("^← 200 \\(\\d+ms\\)$").matches(lines.last()), lines.last())
    }

    @Test
    fun setsTheUserAgent() = runBlocking<Unit> {
        val client = Env.client { middleware.add(UserAgentMiddleware("archon-e2e/1.0")) }
        assertEquals("archon-e2e/1.0", client.echo.echoHeadersCookies(listOf("r1"), "dark").headers["user-agent"])
    }

    @Test
    fun runsMiddlewareInRegistrationOrderConfigFirstThenUse() = runBlocking<Unit> {
        val order = mutableListOf<String>()
        fun tag(name: String) = Middleware { request, next, _ ->
            order.add(">$name")
            val trace = request.headers["X-Trace"]
            request.headers["X-Trace"] = if (trace == null) name else "$trace,$name"
            val response = next(request)
            order.add("<$name")
            response
        }
        val client = Env.client {
            middleware.add(tag("a"))
            middleware.add(tag("b"))
        }
        client.use(tag("c"))
        val echo = client.echo.echoHeadersCookies(listOf("r1"), "dark")
        assertEquals("a,b,c", echo.headers["x-trace"])
        assertEquals(listOf(">a", ">b", ">c", "<c", "<b", "<a"), order)
    }
}
