package archon.runtime

import archon.runtime.TestApi.core
import archon.runtime.TestApi.op
import archon.runtime.TestApi.text
import io.ktor.http.HttpMethod
import io.ktor.http.content.OutgoingContent
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Test
import kotlin.test.assertContains
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BodyTest {
    private fun bytesOf(body: ApiBody): ByteArray = (body.content() as OutgoingContent.ByteArrayContent).bytes()

    @Test
    fun encodesJsonWithExactContentType() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val values = RequestValues().jsonBody(TestPet("a", 2), TestPet.serializer())
            core(server.url).send(op("/x", HttpMethod.Post, body = BodyKind.Json, mediaType = "application/json", responses = text), values, ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("application/json", server.last.header("content-type"))
            assertEquals("{\"name\":\"a\",\"count\":2}", server.last.bodyText)
        }
    }

    @Test
    fun encodesTextAndBinaryWithMediaType() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val core = core(server.url)
            core.send(op("/t", HttpMethod.Post, body = BodyKind.Text, mediaType = "text/plain", responses = text), RequestValues().textBody("héllo"), ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("text/plain", server.last.header("content-type"))
            assertEquals("héllo", server.last.bodyText)

            val binary = op("/b", HttpMethod.Post, body = BodyKind.Binary, mediaType = "application/octet-stream", responses = text)
            core.send(binary, RequestValues().binaryBody(ApiFile("raw bytes".encodeToByteArray())), ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("application/octet-stream", server.last.header("content-type"))
            assertEquals("9", server.last.header("content-length"))

            // The file's own type wins over the operation's media type.
            core.send(binary, RequestValues().binaryBody(ApiFile(byteArrayOf(1), contentType = "image/png")), ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("image/png", server.last.header("content-type"))
        }
    }

    @Test
    fun encodesFormWithRepeatedArrayFields() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val form = op("/f", HttpMethod.Post, body = BodyKind.Form, mediaType = "application/x-www-form-urlencoded", responses = text)
            val core = core(server.url)
            core.send(form, RequestValues().formBody(TestForm("a b&c", 2, listOf("x", "y")), TestForm.serializer()), ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("application/x-www-form-urlencoded", server.last.header("content-type"))
            assertEquals("name=a+b%26c&count=2&tags=x&tags=y", server.last.bodyText)

            // Objects become JSON text.
            core.send(form, RequestValues().formBody(TestForm("n", 1, emptyList(), mapOf("k" to 1)), TestForm.serializer()), ResponseDecoder.text, ErrorDecoders.None, null)
            assertEquals("name=n&count=1&meta=%7B%22k%22%3A1%7D", server.last.bodyText)
        }
    }

    @Test
    fun formBodyRejectsNonObjects() {
        assertFailsWith<IllegalArgumentException> { RequestValues().formBody(listOf("a"), ListSerializer(String.serializer())) }
    }

    @Test
    fun encodesMultipartWithQuotedNamesAndFilenames() = runBlocking<Unit> {
        TestServer.start { TestResponse(200, "ok") }.use { server ->
            val body = MultipartBody()
                .addText("name", "hello")
                .addText("skipped", null)
                .addJson("count", 1, Int.serializer())
                .addJson("tags", listOf("a", "b"), ListSerializer(String.serializer()))
                .addText("we\"ird\r\n", "v")
                .addFile("file", ApiFile(ByteArray(10), "data.bin", "application/octet-stream"))
                .addFiles("attachments", listOf(ApiFile("abc".encodeToByteArray(), "a.txt"), ApiFile("hello".encodeToByteArray(), "b.txt", "text/plain")))
                .addFile("missing", null)
                .addFiles("none", null)
            val operation = op("/m", HttpMethod.Post, body = BodyKind.Multipart, mediaType = "multipart/form-data", responses = text)
            core(server.url).send(operation, RequestValues().body(body), ResponseDecoder.text, ErrorDecoders.None, null)

            val contentType = server.last.header("content-type")!!
            assertTrue(contentType.startsWith("multipart/form-data; boundary="), contentType)
            val boundary = contentType.substringAfter("boundary=")
            val text = server.last.bodyText
            assertTrue(text.startsWith("--$boundary\r\n"), text)
            assertTrue(text.endsWith("--$boundary--\r\n"), text)
            assertContains(text, "Content-Disposition: form-data; name=\"name\"\r\n\r\nhello\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"count\"\r\n\r\n1\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"tags\"\r\n\r\na\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"tags\"\r\n\r\nb\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"we%22ird%0D%0A\"\r\n\r\nv\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"file\"; filename=\"data.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"attachments\"; filename=\"a.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n")
            assertContains(text, "Content-Disposition: form-data; name=\"attachments\"; filename=\"b.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n")
            assertFalse(text.contains("filename*"))
            assertFalse(text.contains("skipped"))
            assertFalse(text.contains("missing"))
            assertFalse(text.contains("none"))
            assertEquals(server.last.body.size.toString(), server.last.header("content-length"))
        }
    }

    @Test
    fun multipartAddJsonExpandsArraysAndSkipsNull() {
        val body = MultipartBody()
            .addJson("title", "hello", String.serializer())
            .addJson("count", 2, Int.serializer().nullable)
            .addJson("none", null, Int.serializer().nullable)
            .addJson("tags", listOf("a", null, "b"), ListSerializer(String.serializer().nullable))
            .addJson("meta", mapOf("k" to 1), MapSerializer(String.serializer(), Int.serializer()))
            .addJson("ratio", 2.0, Double.serializer())
        val text = bytesOf(body).decodeToString()
        assertContains(text, "name=\"title\"\r\n\r\nhello\r\n")
        assertContains(text, "name=\"count\"\r\n\r\n2\r\n")
        assertContains(text, "name=\"tags\"\r\n\r\na\r\n")
        assertContains(text, "name=\"tags\"\r\n\r\nb\r\n")
        assertContains(text, "name=\"meta\"\r\n\r\n{\"k\":1}\r\n")
        assertContains(text, "name=\"ratio\"\r\n\r\n2\r\n")
        assertFalse(text.contains("none"))
        assertEquals(2, Regex("name=\"tags\"").findAll(text).count())
    }

    @Test
    fun formBodyFromJsonSkipsNullsAndExpandsArrays() {
        val obj = ApiJson.parseToJsonElement("""{"a":null,"b":[1,null,true],"c":{"x":null},"d":"é"}""") as JsonObject
        assertEquals("b=1&b=true&c=%7B%22x%22%3Anull%7D&d=%C3%A9", bytesOf(FormBody.fromJson(obj)).decodeToString())
        assertEquals("a=1&a=2", bytesOf(FormBody().add("a", "1").add("a", "2")).decodeToString())
    }

    @Test
    fun channelBodyIsNotReplayable() {
        val body = ChannelBody(ByteReadChannel(byteArrayOf(1, 2, 3)), "application/octet-stream")
        assertFalse(body.replayable)
        assertEquals("application/octet-stream", body.contentType)
        assertFalse(ApiRequest(HttpMethod.Post, "http://127.0.0.1/", ApiHeaders(), body).replayable)
        assertTrue(ApiRequest(HttpMethod.Get, "http://127.0.0.1/", ApiHeaders(), null).replayable)
        assertTrue(BytesBody(byteArrayOf(1), null).replayable)
        assertTrue(MultipartBody().addFile("f", ApiFile(byteArrayOf(1))).replayable)
        assertTrue(FormBody().replayable)
        body.content()
        assertFailsWith<IllegalStateException> { body.content() }
    }

    @Test
    fun multipartBodyCanBeSentTwice() {
        val body = MultipartBody().addText("a", "1").addFile("f", ApiFile(byteArrayOf(1, 2), "f.bin"))
        val first = bytesOf(body)
        val second = bytesOf(body)
        assertContains(first.decodeToString(), "name=\"a\"")
        assertContentEquals(first, second)
    }

    @Test
    fun apiFileSerializesAsBase64() {
        assertEquals("\"AQID\"", ApiJson.encodeToString(ApiFile.serializer(), ApiFile(byteArrayOf(1, 2, 3))))
        assertContentEquals(byteArrayOf(1, 2, 3), ApiJson.decodeFromString(ApiFile.serializer(), "\"AQID\"").content)
        assertFailsWith<kotlinx.serialization.SerializationException> { ApiJson.decodeFromString(ApiFile.serializer(), "\"@@\"") }
    }
}
