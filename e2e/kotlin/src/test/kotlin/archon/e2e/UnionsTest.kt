package archon.e2e

import archon.edgecases.models.Cat
import archon.edgecases.models.Circle
import archon.edgecases.models.Dog
import archon.edgecases.models.Priority
import archon.edgecases.models.Shape
import archon.edgecases.models.Square
import archon.edgecases.models.Status
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull

class UnionsTest {
    private val client = Env.client()

    private fun describe(shape: Shape): String = when (shape) {
        is Circle -> "circle r=${shape.radius}"
        is Square -> "square s=${shape.side}"
        is Shape.Unknown -> "unknown side=${shape.raw.jsonObject["side"]?.jsonPrimitive?.int}"
    }

    @Test
    fun narrowsADiscriminatedUnionAndKeepsAnUnknownVariantAsRawJson() = runBlocking<Unit> {
        val shapes = client.unions.listShapes()
        assertEquals(listOf("circle r=1.0", "square s=2.0", "unknown side=3"), shapes.map(::describe))
        assertEquals(Circle(radius = 1.0), shapes[0])
        assertEquals(Square(side = 2.0), shapes[1])
        val unknown = assertIs<Shape.Unknown>(shapes[2])
        assertEquals("hexagon", unknown.raw.jsonObject["kind"]?.jsonPrimitive?.content)
    }

    @Test
    fun receivesAnUntaggedUnionByTryingVariantsInOrder() = runBlocking<Unit> {
        val pets = client.unions.listPets()
        val cat = assertIs<Cat>(pets[0])
        assertEquals("Tama" to true, cat.name to cat.meows)
        val dog = assertIs<Dog>(pets[1])
        assertEquals("Pochi" to true, dog.name to dog.barks)
        assertEquals(listOf("meow", "woof"), pets.map { if (it is Cat) "meow" else "woof" })
    }

    @Test
    fun receivesKnownAndUnknownEnumValuesWithoutFailing() = runBlocking<Unit> {
        val values = client.unions.getEnumValues()
        assertEquals(Status.Active, values.status)
        assertEquals(Priority._2, values.priority)
        assertEquals(Status.Pending, values.statuses[0])
        assertFalse(values.statuses[1].isKnown)
        assertEquals("archived", values.statuses[1].value)
        assertNull(values.color)
        assertFalse(values.level!!.isKnown)
        assertEquals("unknown-level", values.level!!.value)
    }

    @Test
    fun keepsDateTimeAndDateValuesAsTheirStringsIncludingNestedArrays() = runBlocking<Unit> {
        val dates = client.unions.getDates()
        assertEquals("2026-10-25T12:34:56.789Z", dates.createdAt)
        assertEquals("2000-01-02", dates.birthday)
        assertNull(dates.updatedAt)
        assertEquals(listOf("2026-10-25T09:00:00+09:00", "2026-10-26T00:00:00Z"), dates.timestamps)
        val entry = dates.history[0]
        assertEquals("2026-10-25T00:00:00Z", entry.at)
        assertEquals(3, entry.days.flatten().size)
        assertEquals("2026-10-03", entry.days[1][0])
        assertEquals("2026-01-01T00:00:00Z", dates.byKey!!["first"])
    }
}
