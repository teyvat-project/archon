package archon.e2e

import archon.edgecases.core.ApiException
import archon.edgecases.core.bodyAs
import archon.edgecases.models.Error
import archon.edgecases.models.NotFoundError
import archon.edgecases.models.ValidationError
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ErrorsTest {
    private val client = Env.client()

    @Test
    fun returnsTheSuccessBodyFor200() = runBlocking<Unit> {
        assertTrue(client.errors.getError(200).ok)
    }

    @Test
    fun throwsATypedErrorBodyFor404() = runBlocking<Unit> {
        val error = assertFailsWith<ApiException> { client.errors.getError(404) }
        assertEquals(404, error.statusCode)
        val body = error.bodyAs<NotFoundError>()!!
        assertEquals("Not found" to "errors/404", body.message to body.resource)
    }

    @Test
    fun throwsThe400ValidationErrorBody() = runBlocking<Unit> {
        val error = assertFailsWith<ApiException> { client.errors.getError(400) }
        assertEquals(400, error.statusCode)
        val body = error.bodyAs<ValidationError>()!!
        assertEquals("Validation failed", body.message)
        val field = body.fields.single()
        assertEquals("status" to "invalid", field.name to field.reason)
    }

    @ParameterizedTest
    @ValueSource(ints = [418, 500])
    fun throwsTheDefaultErrorBodyForAnyOtherStatus(status: Int) = runBlocking<Unit> {
        val error = assertFailsWith<ApiException> { client.errors.getError(status) }
        assertEquals(status, error.statusCode)
        assertEquals(status, error.bodyAs<Error>()!!.code)
    }
}
