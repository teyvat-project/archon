package archon.runtime

import archon.runtime.TestApi.core
import archon.runtime.TestApi.op
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpMethod
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class TransportTest {
    private val schemes = mapOf(
        "apiKeyHeader" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
        "apiKeyQuery" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
    )

    private val text = ResponseDecoder.text

    private val credentials = Middleware { request, next, _ ->
        request.headers["X-API-Key"] = "k"
        request.headers["Authorization"] = "Bearer t"
        request.headers["Cookie"] = "session=s"
        request.setQueryParameter("api_key", "k")
        next(request)
    }

    private fun redirect(status: Int, location: String) = TestResponse(status, "", mapOf("Location" to location))

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun manualRedirectStripsCredentialsOnCrossOriginHop(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "landed") }.use { target ->
            TestServer.start { redirect(302, "${target.url}/echo?x=1") }.use { origin ->
                TestApi.client(engine).use { http ->
                    val core = core(origin.url, schemes) {
                        httpClient = http
                        middleware.add(credentials)
                    }
                    val result = core.send(op("/start"), RequestValues(), text, ErrorDecoders.None, null)

                    assertEquals("landed", result.data)
                    assertEquals("${target.url}/echo?x=1", result.url)
                    assertEquals("/start?api_key=k", origin.last.target)
                    assertEquals("k", origin.last.header("x-api-key"))
                    assertEquals("Bearer t", origin.last.header("authorization"))
                    assertEquals("session=s", origin.last.header("cookie"))
                    val hop = target.last
                    assertEquals("/echo?x=1", hop.target)
                    assertNull(hop.header("x-api-key"))
                    assertNull(hop.header("authorization"))
                    assertNull(hop.header("cookie"))
                }
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun crossOriginHopDropsApiKeyQuery(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "landed") }.use { target ->
            TestServer.start { redirect(307, "${target.url}/echo?api_key=k&y=2&API_KEY=k2") }.use { origin ->
                TestApi.client(engine).use { http ->
                    val core = core(origin.url, schemes) {
                        httpClient = http
                        middleware.add(credentials)
                    }
                    core.send(op("/start"), RequestValues(), text, ErrorDecoders.None, null)
                    assertEquals("/echo?y=2&API_KEY=k2", target.last.target)
                }
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun sameOriginRedirectKeepsHeaders(engine: String) = runBlocking<Unit> {
        TestServer.start { if (it.target.startsWith("/start")) redirect(301, "/next") else TestResponse(200, "ok") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core(server.url, schemes) {
                    httpClient = http
                    middleware.add(credentials)
                }
                val result = core.send(op("/start"), RequestValues(), text, ErrorDecoders.None, null)
                assertEquals("/next", server.last.target)
                assertEquals("${server.url}/next", result.url)
                assertEquals("k", server.last.header("x-api-key"))
                assertEquals("Bearer t", server.last.header("authorization"))
                assertEquals("session=s", server.last.header("cookie"))
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun seeOtherConvertsPostToGet(engine: String) = runBlocking<Unit> {
        TestServer.start { if (it.target == "/start") redirect(303, "/next") else TestResponse(200, "ok") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core(server.url) { httpClient = http }
                val operation = op("/start", HttpMethod.Post, body = BodyKind.Text, mediaType = "text/plain")
                core.send(operation, RequestValues().textBody("payload"), text, ErrorDecoders.None, null)
                assertEquals("POST", server.requests.first().method)
                assertEquals("payload", server.requests.first().bodyText)
                val hop = server.last
                assertEquals("GET", hop.method)
                assertEquals("/next", hop.target)
                assertEquals(0, hop.body.size)
                assertNull(hop.header("content-type"))
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun temporaryRedirectResendsTheBody(engine: String) = runBlocking<Unit> {
        TestServer.start { if (it.target == "/start") redirect(307, "/next") else TestResponse(200, "ok") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core(server.url) { httpClient = http }
                val operation = op("/start", HttpMethod.Post, body = BodyKind.Multipart, mediaType = "multipart/form-data")
                core.send(operation, RequestValues().body(MultipartBody().addText("a", "1")), text, ErrorDecoders.None, null)
                val first = server.requests.first()
                val hop = server.last
                assertEquals("POST", hop.method)
                assertEquals("/next", hop.target)
                assertEquals(first.bodyText, hop.bodyText)
                assertEquals(first.header("content-type"), hop.header("content-type"))
                assertContains(hop.bodyText, "name=\"a\"\r\n\r\n1\r\n")
            }
        }
    }

    @Test
    fun nonReplayableBodyReturnsTheRedirect() = runBlocking<Unit> {
        TestServer.start { if (it.target == "/start") redirect(307, "/next") else TestResponse(200, "ok") }.use { server ->
            val operation = op("/start", HttpMethod.Post, body = BodyKind.Binary, mediaType = "application/octet-stream")
            val body = ChannelBody(ByteReadChannel("streamed".encodeToByteArray()), "application/octet-stream")
            val error = assertFailsWith<ApiException> {
                core(server.url).send(operation, RequestValues().body(body), text, ErrorDecoders.None, null)
            }
            assertEquals(307, error.statusCode)
            assertEquals(1, server.requests.size)
            assertEquals("streamed", server.last.bodyText)
        }
    }

    @Test
    fun stopsAfterTwentyRedirects() = runBlocking<Unit> {
        TestServer.start { redirect(302, "/again") }.use { server ->
            assertFailsWith<ApiTransportException> { core(server.url).send(op("/start"), RequestValues(), text, ErrorDecoders.None, null) }
            assertEquals(21, server.requests.size)
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun userHttpClientIsUsedEvenWithFollowRedirectsAndExpectSuccess(engine: String) = runBlocking<Unit> {
        TestServer.start { if (it.target == "/missing") TestResponse.json(404, "{\"message\":\"nope\"}") else TestResponse(200, "landed") }.use { target ->
            TestServer.start { redirect(302, "${target.url}/echo") }.use { origin ->
                val http = TestApi.client(engine) {
                    followRedirects = true
                    expectSuccess = true
                    install(DefaultRequest) { header("X-Default", "d") }
                }
                http.use {
                    val core = core(origin.url, schemes) {
                        httpClient = http
                        middleware.add(credentials)
                    }
                    assertEquals("landed", core.send(op("/start"), RequestValues(), text, ErrorDecoders.None, null).data)
                    assertEquals(1, origin.requests.size)
                    assertEquals("d", origin.last.header("x-default"))
                    assertEquals("k", origin.last.header("x-api-key"))
                    assertEquals("/echo", target.last.target)
                    assertNull(target.last.header("x-api-key"))
                    assertNull(target.last.header("authorization"))
                    assertNull(target.last.header("cookie"))

                    val missing = core(target.url) { httpClient = http }
                    val errors = ErrorDecoders().json("404", TestProblem.serializer())
                    val error = assertFailsWith<ApiException> { missing.send(op("/missing"), RequestValues(), text, errors, null) }
                    assertEquals(404, error.statusCode)
                    assertEquals(TestProblem("nope"), error.body)
                }
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun closeDoesNotCloseUserClient(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core(server.url) { httpClient = http }
                assertEquals("ok", core.send(op("/a"), RequestValues(), text, ErrorDecoders.None, null).data)
                core.close()

                assertEquals("ok", http.get("${server.url}/direct").bodyAsText())
                val again = core(server.url) { httpClient = http }
                assertEquals("ok", again.send(op("/b"), RequestValues(), text, ErrorDecoders.None, null).data)
                again.close()
                assertEquals(listOf("/a", "/direct", "/b"), server.requests.map { it.target })
            }
        }
    }

    @Test
    fun closedCoreRejectsFurtherSends() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val core = core(server.url)
            assertEquals("ok", core.send(op("/a"), RequestValues(), text, ErrorDecoders.None, null).data)
            core.close()
            assertFailsWith<IllegalStateException> { core.send(op("/a"), RequestValues(), text, ErrorDecoders.None, null) }
        }
    }
}
