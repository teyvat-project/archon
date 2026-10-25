package archon.e2e

import archon.edgecases.core.ApiDecodeException
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ResponsesTest {
    private val client = Env.client()

    @Test
    fun decodesTextPlainAsAString() = runBlocking<Unit> {
        assertEquals("hello, archon", client.responses.getText())
    }

    @Test
    fun decodesOctetStreamAsBytes() = runBlocking<Unit> {
        val bytes = client.responses.getBinary()
        assertEquals(256, bytes.size)
        assertEquals(0x00.toByte(), bytes[0])
        assertEquals(0xff.toByte(), bytes[255])
    }

    @Test
    fun returnsWithoutDataFor204NoContent() = runBlocking<Unit> {
        assertEquals(204, client.responses.getEmptyWithResponse().statusCode)
        client.responses.getEmpty()
    }

    // Kotlin differs from C# here: the declared type is not nullable, so an empty body cannot become null.
    @Test
    fun throwsADecodeExceptionForAnEmptyBodyDeclaredAsNonNullJson() = runBlocking<Unit> {
        val error = assertFailsWith<ApiDecodeException> { client.responses.getEmptyJson() }
        assertEquals(200, error.statusCode)
        assertEquals("", error.rawBody)
        assertFailsWith<ApiDecodeException> { client.responses.getEmptyJsonWithResponse() }
    }
}
