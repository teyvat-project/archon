package archon.e2e

import archon.edgecases.ApiAuth
import archon.edgecases.core.TokenValue
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import java.net.URI
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class RedirectTest {
    private fun origin(url: String) = URI(url).let { "${it.scheme}://${it.authority}" }

    @Test
    fun dropsCredentialsWhenARedirectCrossesOrigins() = runBlocking<Unit> {
        val client = Env.client {
            auth = ApiAuth(apiKeyHeader = TokenValue("test-key"))
            headers["Authorization"] = "Bearer test-token"
        }
        val result = client.middleware.redirectCrossOriginWithResponse()
        assertEquals(200, result.statusCode)
        assertEquals(origin(Env.secondaryUrl), origin(result.url))
        assertEquals("/echo/headers", result.data.path)
        assertFalse("x-api-key" in result.data.headers)
        assertFalse("authorization" in result.data.headers)
    }
}
