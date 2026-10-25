package archon.runtime

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ErrorsTest {
    @Test
    fun apiExceptionExposesStatusBodyAndRaw() {
        val headers = ApiHeaders().apply { this["X-A"] = "1" }
        val error = ApiException(404, headers, "\"nope\"", "http://127.0.0.1/x", body = "nope")
        assertEquals(404, error.statusCode)
        assertEquals("\"nope\"", error.rawBody)
        assertEquals("1", error.headers["x-a"])
        assertEquals("http://127.0.0.1/x", error.url)
        assertEquals("nope", error.bodyAs<String>())
        assertNull(error.bodyAs<Int>())
        assertTrue(error.message!!.contains("404"))
    }

    @Test
    fun apiExceptionWithoutBodyHasNullBodyAs() {
        val error = ApiException(500, ApiHeaders(), null, "http://127.0.0.1/x", message = "boom")
        assertNull(error.bodyAs<String>())
        assertEquals("boom", error.message)
    }

    @Test
    fun otherExceptionsCarryTheirDetails() {
        assertTrue(ApiTransportException("t", null, timedOut = true).timedOut)
        assertEquals("raw", ApiDecodeException(200, "raw", "d").rawBody)
        assertEquals(listOf("bearerAuth"), ApiAuthException(listOf("bearerAuth"), "a").schemes)
    }
}
