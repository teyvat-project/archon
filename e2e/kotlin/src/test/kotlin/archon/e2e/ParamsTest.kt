package archon.e2e

import archon.edgecases.models.EchoPathStylesMatrix
import archon.edgecases.models.EchoQueryStylesFilter
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class ParamsTest {
    private val client = Env.client()

    @Test
    fun serializesAllPathStyles() = runBlocking<Unit> {
        val echo = client.echo.echoPathStyles(listOf("a", "b"), listOf("a", "b"), EchoPathStylesMatrix(x = 1, y = 2))
        assertEquals("GET", echo.method)
        assertEquals("/echo/path/a,b/.a.b/;x=1;y=2", echo.path)
        assertEquals("", echo.query)
    }

    @Test
    fun percentEncodesReservedCharacters() = runBlocking<Unit> {
        val echo = client.echo.echoPathStyles(listOf("a/b?c#d e", "日本"), listOf("x"), EchoPathStylesMatrix(x = 1, y = 2))
        assertEquals("/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2", echo.path)
    }

    @Test
    fun serializesAllQueryStyles() = runBlocking<Unit> {
        val echo = client.echo.echoQueryStyles(
            formExploded = listOf("a", "b"),
            formFlat = listOf("a", "b"),
            spaced = listOf("a", "b"),
            piped = listOf(1, 2),
            filter = EchoQueryStylesFilter(status = "active", minAge = 3),
            reserved = "a/b?c:d",
            limit = 10,
        )
        assertEquals("/echo/query", echo.path)
        assertEquals(
            listOf(
                "formExploded=a&formExploded=b",
                "formFlat=a,b",
                "spaced=a%20b",
                "piped=1|2",
                "filter[status]=active&filter[minAge]=3",
                "reserved=a/b?c:d",
                "limit=10",
            ).joinToString("&"),
            echo.query,
        )
    }

    @Test
    fun omitsUnsetQueryParameters() = runBlocking<Unit> {
        assertEquals("limit=1", client.echo.echoQueryStyles(limit = 1).query)
    }

    @Test
    fun sendsHeaderArrayAndCookies() = runBlocking<Unit> {
        val echo = client.echo.echoHeadersCookies(listOf("a", "b"), "dark", xTrace = "trace-1", tags = listOf("x", "y"))
        assertEquals("a,b", echo.headers["x-request-ids"])
        assertEquals("trace-1", echo.headers["x-trace"])
        assertEquals("theme=dark; tags=x,y", echo.headers["cookie"])
        assertEquals(mapOf("theme" to "dark", "tags" to "x,y"), echo.cookies)
    }
}
