package archon.e2e

import archon.edgecases.core.ApiFile
import archon.edgecases.core.ApiJson
import archon.edgecases.models.EchoFormBody
import archon.edgecases.models.EchoMultipartBody
import archon.edgecases.models.JsonPayload
import archon.edgecases.models.Nested
import archon.edgecases.models.Node
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BodiesTest {
    private val client = Env.client()

    @Test
    fun sendsAJsonBody() = runBlocking<Unit> {
        val payload = JsonPayload(name = "archon", count = 3, tags = listOf("a", "b"), note = null, nested = Nested(flag = true))
        val echo = client.echo.echoJson(payload)
        assertEquals("POST", echo.method)
        assertEquals("application/json", echo.contentType)
        val sent = ApiJson.decodeFromString(JsonPayload.serializer(), echo.body!!)
        assertEquals(payload, sent)
        // Optional nulls are not written (the "unset" vs "null" distinction is out of scope).
        assertFalse("note" in echo.body!!)
    }

    @Test
    fun sendsAUrlEncodedFormBodyWithRepeatedArrayFields() = runBlocking<Unit> {
        val echo = client.echo.echoForm(EchoFormBody(name = "a b&c", count = 2, tags = listOf("x", "y")))
        assertEquals("application/x-www-form-urlencoded", echo.contentType)
        assertEquals("name=a+b%26c&count=2&tags=x&tags=y", echo.body)
    }

    @Test
    fun sendsAMultipartBodyWithFileNamesAndSizes() = runBlocking<Unit> {
        val echo = client.echo.echoMultipart(
            EchoMultipartBody(
                title = "hello",
                file = ApiFile(ByteArray(10), "data.bin", "application/octet-stream"),
                attachments = listOf(ApiFile("abc".encodeToByteArray(), "a.txt"), ApiFile("hello".encodeToByteArray(), "b.txt")),
            ),
        )
        assertTrue(echo.contentType!!.startsWith("multipart/form-data; boundary="), echo.contentType)
        assertEquals("{\"title\":\"hello\"}", echo.body)
        assertEquals(
            listOf(Triple("file", "data.bin", 10), Triple("attachments", "a.txt", 3), Triple("attachments", "b.txt", 5)),
            echo.files!!.map { Triple(it.field, it.name, it.size) },
        )
    }

    @Test
    fun sendsABinaryBody() = runBlocking<Unit> {
        val echo = client.echo.echoBinary(ApiFile("raw bytes".encodeToByteArray()))
        assertEquals("application/octet-stream", echo.contentType)
        assertEquals("9", echo.headers["content-length"])
        assertEquals("raw bytes", echo.body)
    }

    @Test
    fun sendsAPlainTextBody() = runBlocking<Unit> {
        val echo = client.echo.echoText("hello, text")
        assertEquals("text/plain", echo.contentType)
        assertEquals("hello, text", echo.body)
    }

    @Test
    fun roundTripsARecursiveAllOfTreeTheServerAssigningIds() = runBlocking<Unit> {
        val result = client.nodes.createNodeWithResponse(
            Node(
                id = "placeholder",
                name = "root",
                labels = mapOf("env" to "test"),
                children = listOf(
                    Node(id = "placeholder", name = "a", children = listOf(Node(id = "placeholder", name = "a1", children = emptyList()))),
                    Node(id = "placeholder", name = "b", children = emptyList()),
                ),
            ),
        )
        assertEquals(201, result.statusCode)
        val root = result.data
        assertEquals("n1", root.id)
        assertNull(root.parentId)
        assertEquals("root", root.name)
        assertEquals("test", root.labels!!["env"])
        assertEquals(listOf("n2", "n4"), root.children.map { it.id })
        assertTrue(root.children.all { it.parentId == "n1" })
        val a1 = root.children[0].children.single()
        assertEquals(Triple("n3", "n2", "a1"), Triple(a1.id, a1.parentId, a1.name))
        assertTrue(root.children[1].children.isEmpty())
    }
}
