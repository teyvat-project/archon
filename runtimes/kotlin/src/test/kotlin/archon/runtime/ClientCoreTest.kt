package archon.runtime

import archon.runtime.TestApi.core
import archon.runtime.TestApi.op
import archon.runtime.TestApi.p
import archon.runtime.TestApi.q
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class ClientCoreTest {
    private val pet = ResponseDecoder.json(TestPet.serializer())

    @Test
    fun buildsUrlPreservingBaseUrlPath() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val values = RequestValues().path("id", 1, Int.serializer())
            core("${server.url}/api/").send(op("/foo/{id}", params = listOf(p("id"))), values, pet, ErrorDecoders.None, null)
            assertEquals("GET /api/foo/1 HTTP/1.1", server.last.line)
        }
    }

    @Test
    fun appendsQueryToBaseUrlQuery() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val values = RequestValues().query("q", "a b", String.serializer())
            core("${server.url}/api?v=1").send(op("/foo", params = listOf(q("q"))), values, pet, ErrorDecoders.None, null)
            assertEquals("/api/foo?v=1&q=a%20b", server.last.target)
            val override = RequestOptions(baseUrl = "${server.url}/other/")
            core("${server.url}/api").send(op("/foo"), RequestValues(), pet, ErrorDecoders.None, override)
            assertEquals("/other/foo", server.last.target)
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun sendsPipeBracketsAndEscapesUnchanged(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core(server.url) {
                    httpClient = http
                    // Added by hand: the parameter serializer would encode '%' itself.
                    middleware.add(Middleware { request, next, _ ->
                        request.url += "&x=%41"
                        next(request)
                    })
                }
                val values = RequestValues()
                    .path("name", "a/b", String.serializer())
                    .query("piped", listOf(1, 2), ListSerializer(Int.serializer()))
                    .query("filter", mapOf("a" to "b"), MapSerializer(String.serializer(), String.serializer()))
                val params = listOf(
                    p("name"),
                    ParamSpec("piped", ParamLocation.Query, ParamStyle.PipeDelimited, false),
                    ParamSpec("filter", ParamLocation.Query, ParamStyle.DeepObject, true),
                )
                core.send(op("/files/{name}", params = params), values, pet, ErrorDecoders.None, null)
                assertEquals("GET /files/a%2Fb?piped=1|2&filter[a]=b&x=%41 HTTP/1.1", server.last.line)
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun keepsRepeatedAndMixedCaseQueryNamesInOrder(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            TestApi.client(engine).use { http ->
                val core = core("${server.url}/r?a=1&b=2&a=3&A=4&flag&e=") { httpClient = http }
                core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null)
                assertEquals("/r/x?a=1&b=2&a=3&A=4&flag&e=", server.last.target)
            }
        }
    }

    @Test
    fun setQueryParameterReplacesByDecodedNameAndKeepsOtherBytes() {
        val request = ApiRequest(HttpMethod.Get, "http://h.test/p?piped=1|2&api%5Fkey=old&x=%41&api_key=older#frag")
        request.setQueryParameter("api_key", "n w")
        assertEquals("http://h.test/p?piped=1|2&x=%41&api_key=n%20w", request.url)
        val bare = ApiRequest(HttpMethod.Get, "http://h.test/p")
        bare.setQueryParameter("k", "v")
        assertEquals("http://h.test/p?k=v", bare.url)
    }

    @Test
    fun resolvesLocationsAndComparesOrigins() {
        val base = "http://h.test/a/b?q=1"
        assertEquals("http://h.test/next", ApiUrl.resolve(base, "/next"))
        assertEquals("http://h.test/a/c?x=%41|", ApiUrl.resolve(base, "c?x=%41|"))
        assertEquals("http://h.test/c", ApiUrl.resolve(base, "../c"))
        assertEquals("http://h.test/a/b?z", ApiUrl.resolve(base, "?z"))
        assertEquals("http://o.test/x", ApiUrl.resolve(base, "//o.test/x"))
        assertEquals("https://o.test/y?a=1&a=2", ApiUrl.resolve(base, "https://o.test/y?a=1&a=2"))
        assertEquals(ApiUrl.origin("http://H.test/x"), ApiUrl.origin("http://h.test:80/y"))
        assertEquals(ApiUrl.origin("https://h.test/"), ApiUrl.origin("https://user@h.test:443"))
        assertFalse(ApiUrl.origin("http://h.test/") == ApiUrl.origin("http://h.test:8080/"))
        assertFalse(ApiUrl.origin("http://h.test/") == ApiUrl.origin("https://h.test/"))
        assertEquals("http://[::1]:80", ApiUrl.origin("http://[::1]/"))
    }

    @Test
    fun returnsTypedDataOn2xx() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"tama\",\"count\":3,\"extra\":true}", mapOf("X-Total" to "7")) }.use { server ->
            val core = core(server.url) { headers["X-Static"] = "s" }
            val result = core.send(op("/pets"), RequestValues(), pet, ErrorDecoders.None, RequestOptions(headers = linkedMapOf("X-Call" to "c")))
            assertEquals(200, result.statusCode)
            assertEquals(TestPet("tama", 3), result.data)
            assertEquals("7", result.headers["x-total"])
            assertEquals("${server.url}/pets", result.url)
            assertEquals("application/json", server.last.header("accept"))
            assertEquals("s", server.last.header("x-static"))
            assertEquals("c", server.last.header("x-call"))
        }
    }

    @Test
    fun throwsApiExceptionWithParsedBodyOn404() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(404, "{\"message\":\"nope\"}") }.use { server ->
            val errors = ErrorDecoders().json("404", TestProblem.serializer())
            val error = assertFailsWith<ApiException> { core(server.url).send(op("/x"), RequestValues(), pet, errors, null) }
            assertEquals(404, error.statusCode)
            assertEquals(TestProblem("nope"), error.bodyAs<TestProblem>())
            assertEquals("{\"message\":\"nope\"}", error.rawBody)
            assertEquals("${server.url}/x", error.url)
            assertEquals("application/json", error.headers["content-type"])
        }
    }

    @Test
    fun usesRangeAndDefaultErrorDecoders() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(if (it.target == "/a") 418 else 503, "{\"message\":\"m\"}") }.use { server ->
            val core = core(server.url)
            val errors = ErrorDecoders().json("4xx", TestProblem.serializer()).text("default")
            val typed = assertFailsWith<ApiException> { core.send(op("/a"), RequestValues(), pet, errors, null) }
            assertEquals(TestProblem("m"), typed.body)
            val text = assertFailsWith<ApiException> { core.send(op("/b"), RequestValues(), pet, errors, null) }
            assertEquals("{\"message\":\"m\"}", text.body)
            val none = assertFailsWith<ApiException> { core.send(op("/b"), RequestValues(), pet, ErrorDecoders.None, null) }
            assertNull(none.body)
            assertEquals(503, none.statusCode)
        }
    }

    @Test
    fun throwsApiExceptionWithNullBodyWhenErrorIsNotJson() = runBlocking<Unit> {
        TestServer.start { if (it.target == "/empty") TestResponse(500) else TestResponse(500, "<html>") }.use { server ->
            val core = core(server.url)
            val errors = ErrorDecoders().json("default", TestProblem.serializer())
            val error = assertFailsWith<ApiException> { core.send(op("/x"), RequestValues(), pet, errors, null) }
            assertEquals(500, error.statusCode)
            assertNull(error.body)
            assertEquals("<html>", error.rawBody)
            val empty = assertFailsWith<ApiException> { core.send(op("/empty"), RequestValues(), pet, errors, null) }
            assertNull(empty.body)
            assertNull(empty.rawBody)
        }
    }

    @Test
    fun returnsNullFor204WhenTypeIsNullable() = runBlocking<Unit> {
        TestServer.start { if (it.target == "/204") TestResponse(204) else TestResponse.json(200, "") }.use { server ->
            val core = core(server.url)
            val nullable = ResponseDecoder.json(TestPet.serializer().nullable)
            val noContent = core.send(op("/204"), RequestValues(), nullable, ErrorDecoders.None, null)
            assertEquals(204, noContent.statusCode)
            assertNull(noContent.data)
            assertNull(core.send(op("/empty"), RequestValues(), nullable, ErrorDecoders.None, null).data)
            assertEquals(Unit, core.send(op("/204"), RequestValues(), ResponseDecoder.empty, ErrorDecoders.None, null).data)
        }
    }

    @Test
    fun throwsDecodeExceptionFor204WhenTypeIsNotNullable() = runBlocking<Unit> {
        TestServer.start { if (it.target == "/204") TestResponse(204) else TestResponse.json(200, "") }.use { server ->
            val core = core(server.url)
            val noContent = assertFailsWith<ApiDecodeException> { core.send(op("/204"), RequestValues(), pet, ErrorDecoders.None, null) }
            assertEquals(204, noContent.statusCode)
            assertEquals("", noContent.rawBody)
            val empty = assertFailsWith<ApiDecodeException> { core.send(op("/empty"), RequestValues(), pet, ErrorDecoders.None, null) }
            assertEquals(200, empty.statusCode)
            assertEquals("", empty.rawBody)
        }
    }

    @Test
    fun throwsDecodeExceptionOnInvalidJson() = runBlocking<Unit> {
        TestServer.start { if (it.target == "/missing") TestResponse.json(200, "{}") else TestResponse.json(200, "{not json") }.use { server ->
            val core = core(server.url)
            val error = assertFailsWith<ApiDecodeException> { core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null) }
            assertEquals("{not json", error.rawBody)
            assertEquals(200, error.statusCode)
            // A required property that is missing is a decode error too.
            assertEquals("{}", assertFailsWith<ApiDecodeException> { core.send(op("/missing"), RequestValues(), pet, ErrorDecoders.None, null) }.rawBody)
        }
    }

    @Test
    fun decodesTextAndBinary() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "hello") }.use { server ->
            val core = core(server.url)
            val textOp = op("/t", responses = TestApi.text)
            assertEquals("hello", core.send(textOp, RequestValues(), ResponseDecoder.text, ErrorDecoders.None, null).data)
            assertEquals("*/*", server.last.header("accept"))
            assertContentEquals("hello".encodeToByteArray(), core.send(textOp, RequestValues(), ResponseDecoder.binary, ErrorDecoders.None, null).data)
        }
    }

    @Test
    fun throwsTransportExceptionOnConnectionRefused() = runBlocking<Unit> {
        val refused = core("http://127.0.0.1:${TestServer.closedPort()}")
        val error = assertFailsWith<ApiTransportException> { refused.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null) }
        assertFalse(error.timedOut)
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun timeoutThrowsTransportExceptionWithTimedOut(engine: String) = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "{}", delayMillis = 5_000) }.use { server ->
            TestApi.client(engine).use { http ->
                val slow = core(server.url) {
                    httpClient = http
                    timeout = 200.milliseconds
                }
                val error = assertFailsWith<ApiTransportException> { slow.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null) }
                assertTrue(error.timedOut)
            }
        }
    }

    @Test
    fun callerTimeoutIsNotReportedAsClientTimeout() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "{}", delayMillis = 5_000) }.use { server ->
            val core = core(server.url) { timeout = 30.seconds }
            assertFailsWith<TimeoutCancellationException> {
                withTimeout(200.milliseconds) { core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null) }
            }
        }
    }

    @ParameterizedTest
    @MethodSource("archon.runtime.TestApi#engines")
    fun callerCancellationPropagatesCancellationException(engine: String) = runBlocking<Unit> {
        val arrived = CompletableDeferred<Unit>()
        TestServer.start {
            arrived.complete(Unit)
            TestResponse(200, "{}", delayMillis = 5_000)
        }.use { server ->
            val http = TestApi.client(engine)
            val core = core(server.url) {
                httpClient = http
                timeout = 30.seconds
            }
            var caught: Throwable? = null
            val job = launch {
                try {
                    core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null)
                } catch (e: Throwable) {
                    caught = e
                    throw e
                }
            }
            arrived.await()
            job.cancel()
            job.join()
            http.close()
            assertIs<CancellationException>(caught)
            assertFalse(caught is ApiTransportException)
        }
    }

    @Test
    fun rejectsRelativeBaseUrl() = runBlocking<Unit> {
        assertFailsWith<IllegalArgumentException> { core("/api").send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null) }
    }

    @Test
    fun runsMiddlewareOuterToInnerWithAuthInnermost() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val order = ArrayList<String>()
            fun recorder(name: String) = Middleware { request, next, _ ->
                order.add("$name:before")
                val response = next(request)
                order.add("$name:after")
                response
            }
            val core = core(server.url) {
                middleware.add(recorder("mw1"))
                middleware.add(recorder("mw2"))
                customAuth = { _, _ -> order.add("auth") }
            }
            core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null)
            assertEquals(listOf("mw1:before", "mw2:before", "auth", "mw2:after", "mw1:after"), order)
        }
    }

    @Test
    fun useAppendsMiddleware() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val core = core(server.url) {
                middleware.add(Middleware { request, next, _ ->
                    request.headers["X-Trace"] = "a"
                    next(request)
                })
            }
            var seen: CallContext? = null
            core.use(Middleware { request, next, context ->
                request.headers["X-Trace"] = request.headers["X-Trace"] + ",b"
                seen = context
                next(request)
            })
            core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, RequestOptions(extensions = linkedMapOf("k" to 1)))
            assertEquals("a,b", server.last.header("x-trace"))
            assertEquals(2, core.options.middleware.size)
            val context = seen!!
            assertEquals("testOp", context.operationName)
            assertEquals(HttpMethod.Get, context.method)
            assertEquals("/x", context.pathTemplate)
            assertEquals(listOf("test"), context.tags)
            assertEquals(1, context.attempt)
            assertEquals(1, context.extensions["k"])
        }
    }

    @Test
    fun exposesCredentialNamesForRedaction() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val schemes = mapOf(
                "h" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Header, "X-API-Key"),
                "q" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),
                "c" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Cookie, "sid"),
                "b" to SecuritySchemeSpec.HttpBearer,
            )
            var seen: CallContext? = null
            val core = core(server.url, schemes) {
                middleware.add(Middleware { request, next, context ->
                    seen = context
                    next(request)
                })
            }
            core.send(op("/x"), RequestValues(), pet, ErrorDecoders.None, null)
            val context = seen!!
            assertTrue("x-api-key" in context.redactHeaders)
            assertEquals(1, context.redactHeaders.size)
            assertTrue("API_KEY" in context.redactQuery)
            assertEquals(1, context.redactQuery.size)
        }
    }

    @Test
    fun sendsHeaderAndCookieParametersInOrder() = runBlocking<Unit> {
        TestServer.start { TestResponse.json(200, "{\"name\":\"x\"}") }.use { server ->
            val params = listOf(
                ParamSpec("X-Ids", ParamLocation.Header, ParamStyle.Simple, false),
                ParamSpec("theme", ParamLocation.Cookie, ParamStyle.Form, true),
                ParamSpec("tags", ParamLocation.Cookie, ParamStyle.Form, false),
            )
            val values = RequestValues()
                .header("X-Ids", listOf("a", "b"), ListSerializer(String.serializer()))
                .cookie("theme", "dark", String.serializer())
                .cookie("tags", listOf("x", "y"), ListSerializer(String.serializer()))
            val core = core(server.url) {
                headers["X-Ids"] = "client"
                headers["X-Static"] = "s"
                headers["Cookie"] = "pre=1"
            }
            core.send(op("/h", params = params), values, pet, ErrorDecoders.None, RequestOptions(headers = linkedMapOf("x-static" to "call")))
            assertEquals("a,b", server.last.header("x-ids"))
            assertEquals("call", server.last.header("x-static"))
            assertEquals("pre=1; theme=dark; tags=x,y", server.last.header("cookie"))
        }
    }

    @Test
    fun callerContentTypeWinsOverBodyType() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val operation = op("/j", HttpMethod.Post, body = BodyKind.Json, mediaType = "application/merge-patch+json", responses = TestApi.text)
            val core = core(server.url) { headers["Content-Type"] = "text/ignored" }
            val values = RequestValues().jsonBody(TestPet("a"), TestPet.serializer())
            core.send(operation, values, ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("application/merge-patch+json", server.last.header("content-type"))
            core.send(operation, values, ResponseDecoder.text, ErrorDecoders.None, RequestOptions(headers = linkedMapOf("content-type" to "application/vnd.x+json")))
            assertEquals("application/vnd.x+json", server.last.header("content-type"))
            assertEquals("{\"name\":\"a\"}", server.last.bodyText)
        }
    }
}
