package archon.runtime

import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.ParametersBuilder
import io.ktor.http.encodedPath
import io.ktor.http.content.OutgoingContent
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.toByteArray
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.nio.channels.UnresolvedAddressException
import kotlin.time.Duration

/** Names that carry credentials and must not cross origins. */
internal class CredentialNames(val headers: List<String>, val query: Set<String>)

internal object Transport {
    private const val MAX_REDIRECTS = 20
    private val redirectStatuses = setOf(301, 302, 303, 307, 308)
    private val bodyHeaders = listOf("Content-Encoding", "Content-Language", "Content-Location", "Content-Type", "Content-Length")

    /**
     * Sends the request, following redirects by hand so credentials are dropped when the origin changes (spec §8.5).
     * The timeout covers the whole exchange, redirects and reading the body included (Ktor buffers the body
     * before `request` returns). The caller's own cancellation stays a [kotlinx.coroutines.CancellationException].
     */
    suspend fun send(http: HttpClient, request: ApiRequest, timeout: Duration?, credentials: CredentialNames): ApiResponse {
        if (timeout == null || !timeout.isPositive()) return exchange(http, request, credentials)
        return try {
            withTimeout(timeout) { exchange(http, request, credentials) }
        } catch (e: TimeoutCancellationException) {
            // A timeout of the caller's own (an enclosing withTimeout) cancels this coroutine too: let it through.
            currentCoroutineContext().ensureActive()
            throw ApiTransportException("Request timed out after ${timeout.inWholeMilliseconds}ms.", e, timedOut = true)
        }
    }

    private suspend fun exchange(http: HttpClient, request: ApiRequest, credentials: CredentialNames): ApiResponse {
        try {
            return follow(http, request, credentials)
        } catch (e: IOException) {
            // Engines may report a cancelled call as an I/O error; cancellation wins.
            currentCoroutineContext().ensureActive()
            throw ApiTransportException("Request failed: ${e.message}", e)
        } catch (e: UnresolvedAddressException) {
            currentCoroutineContext().ensureActive()
            throw ApiTransportException("Request failed: unresolved address.", e)
        }
    }

    private suspend fun follow(http: HttpClient, request: ApiRequest, credentials: CredentialNames): ApiResponse {
        var method = request.method
        var url = request.url
        val headers = request.headers.copy()
        var body = request.body
        var redirects = 0
        while (true) {
            val response = sendOnce(http, method, url, headers, body)
            val status = response.status.value
            val location = response.headers[HttpHeaders.Location]
            if (status !in redirectStatuses || location == null) return toApiResponse(response, url)

            // 303 (except HEAD) and 301/302 on POST switch to a bodiless GET; everything else re-sends the body.
            val toGet = if (status == 303) method != HttpMethod.Head else status < 303 && method == HttpMethod.Post
            if (!toGet && body != null && !body.replayable) return toApiResponse(response, url)
            if (redirects++ >= MAX_REDIRECTS) throw ApiTransportException("Too many redirects (more than $MAX_REDIRECTS).")

            var next = ApiUrl.resolve(url, location)
            if (ApiUrl.origin(next) != ApiUrl.origin(url)) {
                for (name in credentials.headers + listOf("Authorization", "Cookie")) headers.remove(name)
                next = ApiUrl.withoutQueryParameters(next, credentials.query)
            }
            if (toGet) {
                method = HttpMethod.Get
                body = null
                for (name in bodyHeaders) headers.remove(name)
            }
            url = next
        }
    }

    private suspend fun sendOnce(http: HttpClient, method: HttpMethod, url: String, headers: ApiHeaders, body: ApiBody?): HttpResponse =
        http.request {
            this.method = method
            setRawUrl(url)
            for ((name, value) in headers) {
                // Ktor rejects these as headers: they belong to the content.
                if (name.equals(HttpHeaders.ContentType, ignoreCase = true) || name.equals(HttpHeaders.ContentLength, ignoreCase = true)) continue
                this.headers.append(name, value)
            }
            if (body != null) setBody(content(body, headers[HttpHeaders.ContentType]))
        }

    /**
     * Points the builder at [url] without changing a byte of its path or query. `URLBuilder.takeFrom` keeps the
     * encoding but groups query parameters by case-insensitive name (`a=1&b=2&a=3` becomes `a=1&a=3&b=2`), so the
     * query is stored as a single valueless parameter, which is rendered verbatim.
     */
    private fun HttpRequestBuilder.setRawUrl(url: String) {
        url(url)
        val parts = ApiUrl.split(url)
        this.url.encodedPath = parts.path
        this.url.encodedParameters = ParametersBuilder().apply { if (!parts.query.isNullOrEmpty()) appendAll(parts.query, emptyList()) }
        this.url.trailingQuery = parts.query != null
        this.url.encodedFragment = ""
    }

    private suspend fun toApiResponse(response: HttpResponse, url: String): ApiResponse {
        val headers = ApiHeaders()
        response.headers.forEach { name, values -> headers[name] = values.joinToString(", ") }
        // bodyAsBytes() needs the default transformers, which the runtime's client turns off.
        return ApiResponse(response.status.value, headers, url, response.bodyAsChannel().toByteArray())
    }

    /** The body's content carrying [contentType] (the request header, which middleware may have changed). */
    private fun content(body: ApiBody, contentType: String?): OutgoingContent {
        val content = body.content()
        val type = contentType?.let(ContentType::parse) ?: return content
        if (type == content.contentType) return content
        return when (content) {
            is OutgoingContent.ByteArrayContent -> object : OutgoingContent.ByteArrayContent() {
                override val contentType: ContentType get() = type
                override val contentLength: Long? get() = content.contentLength

                override fun bytes(): ByteArray = content.bytes()
            }
            is OutgoingContent.ReadChannelContent -> object : OutgoingContent.ReadChannelContent() {
                override val contentType: ContentType get() = type
                override val contentLength: Long? get() = content.contentLength

                override fun readFrom(): ByteReadChannel = content.readFrom()
            }
            is OutgoingContent.WriteChannelContent -> object : OutgoingContent.WriteChannelContent() {
                override val contentType: ContentType get() = type
                override val contentLength: Long? get() = content.contentLength

                override suspend fun writeTo(channel: ByteWriteChannel) = content.writeTo(channel)
            }
            else -> content
        }
    }
}
