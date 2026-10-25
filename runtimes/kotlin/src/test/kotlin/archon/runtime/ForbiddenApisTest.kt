package archon.runtime

import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertTrue

// The runtime has to work on Android API levels without java.time / java.util.Base64 / java.net.http.
class ForbiddenApisTest {
    private val forbidden = listOf("java.time", "java.util.Base64", "java.net.http", "CompletableFuture")

    @Test
    fun mainSourcesAvoidForbiddenApis() {
        val sources = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(sources.isNotEmpty(), "no runtime sources found")
        val hits = sources.flatMap { file ->
            val text = file.readText()
            forbidden.filter { text.contains(it) }.map { "${file.name}: $it" }
        }
        assertTrue(hits.isEmpty(), "forbidden APIs used: $hits")
    }
}
