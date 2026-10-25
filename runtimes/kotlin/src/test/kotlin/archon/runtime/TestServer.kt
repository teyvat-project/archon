package archon.runtime

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.concurrent.thread

/** A request exactly as it arrived on the wire. */
class RecordedRequest(
    /** The raw request line, e.g. `GET /x?y=1 HTTP/1.1`. */
    val line: String,
    val method: String,
    val target: String,
    /** Header names lower-cased; repeated headers joined with `", "`. */
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    val bodyText: String get() = body.decodeToString()

    fun header(name: String): String? = headers[name.lowercase()]
}

class TestResponse(
    val status: Int,
    val body: String = "",
    val headers: Map<String, String> = emptyMap(),
    val delayMillis: Long = 0,
) {
    companion object {
        fun json(status: Int, json: String, headers: Map<String, String> = emptyMap()) =
            TestResponse(status, json, headers + ("Content-Type" to "application/json"))
    }
}

/** A minimal HTTP/1.1 server on 127.0.0.1 that records raw requests (one request per connection). */
class TestServer private constructor(private val handler: (RecordedRequest) -> TestResponse) : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())

    val port: Int = socket.localPort

    /** `http://127.0.0.1:<port>` (no trailing slash). */
    val url: String = "http://127.0.0.1:$port"

    val requests = ConcurrentLinkedQueue<RecordedRequest>()

    val last: RecordedRequest get() = requests.last()

    init {
        thread(isDaemon = true, name = "test-server-$port") {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    return@thread
                }
                thread(isDaemon = true) { serve(client) }
            }
        }
    }

    override fun close() = socket.close()

    private fun serve(client: Socket): Unit = client.use {
        try {
            val input = client.getInputStream()
            val head = readHead(input) ?: return
            val lines = head.split("\r\n")
            val parts = lines[0].split(' ')
            val headers = LinkedHashMap<String, String>()
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':')
                if (colon <= 0) continue
                val name = line.substring(0, colon).trim().lowercase()
                val value = line.substring(colon + 1).trim()
                headers[name] = headers[name]?.let { "$it, $value" } ?: value
            }
            val body = readBody(input, headers)
            val request = RecordedRequest(lines[0], parts[0], parts[1], headers, body)
            requests.add(request)

            val response = handler(request)
            if (response.delayMillis > 0) Thread.sleep(response.delayMillis)
            val bytes = response.body.encodeToByteArray()
            val builder = StringBuilder("HTTP/1.1 ${response.status} X\r\n")
            for ((name, value) in response.headers) builder.append("$name: $value\r\n")
            builder.append("Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
            val output = client.getOutputStream()
            output.write(builder.toString().toByteArray(Charsets.US_ASCII))
            output.write(bytes)
            output.flush()
        } catch (_: Exception) {
            // The client went away (timeouts, cancellation): nothing to report.
        }
    }

    private fun readHead(input: InputStream): String? {
        val buffer = ByteArrayOutputStream()
        var matched = 0
        while (true) {
            val b = input.read()
            if (b < 0) return null
            buffer.write(b)
            matched = when {
                (matched == 0 || matched == 2) && b == '\r'.code -> matched + 1
                (matched == 1 || matched == 3) && b == '\n'.code -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) {
                val bytes = buffer.toByteArray()
                return bytes.decodeToString(0, bytes.size - 4)
            }
        }
    }

    private fun readBody(input: InputStream, headers: Map<String, String>): ByteArray {
        headers["content-length"]?.let { return input.readNBytes(it.toInt()) }
        if (headers["transfer-encoding"]?.contains("chunked") != true) return ByteArray(0)
        val output = ByteArrayOutputStream()
        while (true) {
            val size = readLine(input).substringBefore(';').trim().toInt(16)
            if (size == 0) {
                readLine(input)
                return output.toByteArray()
            }
            output.write(input.readNBytes(size))
            readLine(input)
        }
    }

    private fun readLine(input: InputStream): String {
        val buffer = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0 || b == '\n'.code) break
            if (b != '\r'.code) buffer.write(b)
        }
        return buffer.toString(Charsets.US_ASCII)
    }

    companion object {
        fun start(handler: (RecordedRequest) -> TestResponse) = TestServer(handler)

        /** A port nothing listens on. */
        fun closedPort(): Int = ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { it.localPort }
    }
}
