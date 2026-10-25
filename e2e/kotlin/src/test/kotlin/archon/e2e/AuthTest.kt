package archon.e2e

import archon.edgecases.ApiAuth
import archon.edgecases.core.ApiAuthException
import archon.edgecases.core.ApiException
import archon.edgecases.core.BasicValue
import archon.edgecases.core.OAuth2ClientCredentials
import archon.edgecases.core.OAuth2RefreshToken
import archon.edgecases.core.OAuth2Value
import archon.edgecases.core.TokenValue
import archon.edgecases.core.bodyAs
import archon.edgecases.models.Error
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class AuthTest {
    private val clientCredentials get() = OAuth2Value(clientCredentials = OAuth2ClientCredentials("client-id", "client-secret"))

    @Test
    fun bearer() = runBlocking<Unit> {
        val result = Env.client { auth = ApiAuth(bearerAuth = TokenValue("test-token")) }.auth.authBearerWithResponse()
        assertEquals(200, result.statusCode)
        assertEquals("Bearer test-token", result.data.headers["authorization"])
    }

    @Test
    fun basic() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(basicAuth = BasicValue("user", "pass")) }
        assertEquals(200, client.auth.authBasicWithResponse().statusCode)
    }

    @Test
    fun apiKeyInAHeader() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(apiKeyHeader = TokenValue("test-key")) }
        assertEquals("test-key", client.auth.authApiKeyHeader().headers["x-api-key"])
    }

    @Test
    fun apiKeyInTheQuery() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(apiKeyQuery = TokenValue { "test-key" }) }
        assertEquals("api_key=test-key", client.auth.authApiKeyQuery().query)
    }

    @Test
    fun apiKeyInACookie() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(apiKeyCookie = TokenValue("test-key")) }
        assertEquals(mapOf("session" to "test-key"), client.auth.authApiKeyCookie().cookies)
    }

    @Test
    fun rejectsAWrongCredentialWithATyped401() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(bearerAuth = TokenValue("wrong")) }
        val error = assertFailsWith<ApiException> { client.auth.authBearer() }
        assertEquals(401, error.statusCode)
        val body = error.bodyAs<Error>()!!
        assertEquals(401, body.code)
        assertTrue(body.message.isNotEmpty())
    }

    @Test
    fun throwsAuthExceptionWithoutSendingWhenRequiredAuthIsMissing() = runBlocking<Unit> {
        val before = Env.requestCount("/auth/bearer")
        val error = assertFailsWith<ApiAuthException> { Env.client().auth.authBearer() }
        assertEquals(listOf("bearerAuth"), error.schemes)
        assertEquals(before, Env.requestCount("/auth/bearer"))
    }

    @Test
    fun sendsAnonymouslyWhenAuthIsOptionalAndNotConfigured() = runBlocking<Unit> {
        assertFalse("authorization" in Env.client().auth.authOptional().headers)
    }

    @Test
    fun usesTheCredentialForOptionalAuthWhenItIsConfigured() = runBlocking<Unit> {
        val echo = Env.client { auth = ApiAuth(bearerAuth = TokenValue("test-token")) }.auth.authOptional()
        assertEquals("Bearer test-token", echo.headers["authorization"])
    }

    @Test
    fun requiresEverySchemeOfAnAndRequirement() = runBlocking<Unit> {
        val before = Env.requestCount("/auth/and")
        val partial = Env.client { auth = ApiAuth(bearerAuth = TokenValue("test-token")) }
        assertFailsWith<ApiAuthException> { partial.auth.authAnd() }
        assertEquals(before, Env.requestCount("/auth/and"))

        val both = Env.client { auth = ApiAuth(bearerAuth = TokenValue("test-token"), apiKeyHeader = TokenValue("test-key")) }
        assertEquals(200, both.auth.authAndWithResponse().statusCode)
    }

    @Test
    fun oauth2ObtainsATokenWithClientCredentialsFromTheRelativeTokenUrl() = runBlocking<Unit> {
        val before = Env.stats()
        val echo = Env.client { auth = ApiAuth(oauth2 = clientCredentials) }.auth.authOAuth2()
        assertTrue(echo.headers["authorization"]!!.startsWith("Bearer "))
        assertEquals(before.tokensIssued + 1, Env.stats().tokensIssued)
    }

    @Test
    fun oauth2ObtainsATokenWithTheRefreshTokenGrant() = runBlocking<Unit> {
        val refreshed = mutableListOf<String?>()
        val refresh = OAuth2RefreshToken(
            refreshToken = "test-refresh-token",
            clientId = "client-id",
            clientSecret = "client-secret",
            onRefreshed = { refreshed.add(it.refreshToken) },
        )
        val client = Env.client { auth = ApiAuth(oauth2 = OAuth2Value(refreshToken = refresh)) }
        assertEquals(200, client.auth.authOAuth2WithResponse().statusCode)
        assertNotEquals("test-refresh-token", refreshed.single())
    }

    @Test
    fun oauth2RenewsTheTokenBeforeItExpiresInsteadOfWaitingForA401() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(oauth2 = clientCredentials) }
        val before = Env.stats()

        val first = client.auth.authOAuth2()
        // The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
        delay(2100)
        val second = client.auth.authOAuth2()
        assertNotEquals(first.headers["authorization"], second.headers["authorization"])

        val after = Env.stats()
        assertEquals(2, after.tokensIssued - before.tokensIssued)
        assertEquals(2, (after.requests["/auth/oauth2"] ?: 0) - (before.requests["/auth/oauth2"] ?: 0))
    }

    @Test
    fun oauth2IssuesASingleTokenForConcurrentRequestsOnAColdClient() = runBlocking<Unit> {
        val client = Env.client { auth = ApiAuth(oauth2 = clientCredentials) }
        val before = Env.stats()
        val results = coroutineScope { List(5) { async { client.auth.authOAuth2() } }.awaitAll() }
        assertEquals(1, results.map { it.headers["authorization"] }.distinct().size)
        assertEquals(1, Env.stats().tokensIssued - before.tokensIssued)
    }
}
