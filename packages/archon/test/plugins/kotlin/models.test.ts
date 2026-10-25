import { describe, expect, it } from 'vitest';
import { arr, bool, date, dateTime, doc, enumOf, generate, int, model, nullable, num, obj, prop, ref, squash, str, union } from './helpers.js';

const shapes = () =>
  doc({
    Shape: union([ref('Circle'), ref('Square')], { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } }),
    Circle: obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('radius', num, true)]),
    Square: obj([prop('kind', enumOf(['square']), true), prop('side', num, true)]),
  });

const pets = () =>
  doc({
    Pet: union([ref('Cat'), ref('Dog')]),
    Cat: obj([prop('meows', bool, true)]),
    Dog: obj([prop('barks', bool, true)]),
  });

describe('kotlin plugin: models', () => {
  it('renders required, optional and nullable properties with SerialName', async () => {
    const { files } = await generate(
      doc({
        Pet: obj(
          [prop('name', str, true), prop('note', str), prop('count', int), prop('parentId', nullable(str), true), prop('born', date)],
          { description: 'A pet.' },
        ),
      }),
    );
    const pet = model(files, 'Pet');
    expect(pet.startsWith('// Generated header\n')).toBe(true);
    expect(pet).toContain('@file:Suppress("DEPRECATION", "RedundantVisibilityModifier")');
    expect(pet).toContain('package test.api.models');
    expect(pet).toContain('import kotlinx.serialization.SerialName');
    expect(pet).toContain('import kotlinx.serialization.Serializable');
    expect(pet).not.toContain('import kotlinx.serialization.*');
    expect(squash(pet)).toContain(squash('/** * A pet. */ @Serializable public data class Pet('));
    expect(squash(pet)).toContain(squash('@SerialName("name") public val name: String,'));
    expect(squash(pet)).toContain(squash('@SerialName("note") public val note: String? = null,'));
    expect(squash(pet)).toContain(squash('@SerialName("count") public val count: Int? = null,'));
    expect(squash(pet)).toContain(squash('@SerialName("parentId") public val parentId: String?,'));
    expect(squash(pet)).toContain(squash('@SerialName("born") public val born: String? = null, )'));
  });

  it('renders self-referencing schema by name', async () => {
    const { files } = await generate(doc({ Node: obj([prop('id', str, true), prop('children', arr(ref('Node')), true)]) }));
    expect(model(files, 'Node')).toContain('public val children: List<Node>,');
  });

  it('imports runtime types used by properties', async () => {
    const { files } = await generate(doc({ Upload: obj([prop('file', { kind: 'binary', nullable: false }, true)]) }));
    const upload = model(files, 'Upload');
    expect(upload).toContain('import test.api.core.ApiFile');
    expect(upload).toContain('public val file: ApiFile,');
  });

  it('renders extensible enum class with known values and serializer', async () => {
    const { files } = await generate(
      doc({ Status: enumOf(['active', 'in-active', 'value', 'serializer', '']), Priority: enumOf([1, 2], 'integer'), Ratio: enumOf([0.5, 2], 'number') }),
    );
    const status = model(files, 'Status');
    expect(status).toContain('@Serializable(with = Status.Serializer::class)');
    expect(status).toContain('public class Status(public val value: String) {');
    expect(status).toContain('public val Active: Status = Status("active")');
    expect(status).toContain('public val InActive: Status = Status("in-active")');
    expect(status).toContain('public val Value: Status = Status("value")');
    expect(status).toContain('public val Serializer2: Status = Status("serializer")');
    expect(status).toContain('public val Empty: Status = Status("")');
    expect(status).toContain('public val knownValues: List<Status> = listOf(Active, InActive, Value, Serializer2, Empty)');
    expect(squash(status)).toContain(squash('public val isKnown: Boolean get() = when (value) { "active", "in-active", "value", "serializer", "" -> true else -> false }'));
    expect(status).toContain('override fun equals(other: Any?): Boolean = other is Status && other.value == value');
    expect(status).toContain('override fun hashCode(): Int = value.hashCode()');
    expect(status).toContain('override fun toString(): String = value');
    expect(status).toContain('public object Serializer : KSerializer<Status> {');
    expect(status).toContain('PrimitiveSerialDescriptor("test.api.models.Status", PrimitiveKind.STRING)');
    expect(status).toContain('encoder.encodeString(value.value)');
    expect(status).toContain('override fun deserialize(decoder: Decoder): Status = Status(decoder.decodeString())');

    const priority = model(files, 'Priority');
    expect(priority).toContain('public class Priority(public val value: Long) {');
    expect(priority).toContain('public val _1: Priority = Priority(1L)');
    expect(squash(priority)).toContain(squash('when (value) { 1L, 2L -> true'));
    expect(priority).toContain('override fun toString(): String = value.toString()');
    expect(priority).toContain('PrimitiveKind.LONG');
    expect(priority).toContain('encoder.encodeLong(value.value)');
    expect(priority).toContain('Priority(decoder.decodeLong())');

    const ratio = model(files, 'Ratio');
    expect(ratio).toContain('public class Ratio(public val value: Double) {');
    expect(ratio).toContain('Ratio(0.5)');
    expect(ratio).toContain('Ratio(2.0)');
    expect(ratio).toContain('PrimitiveKind.DOUBLE');
  });

  it('renders discriminated union as sealed interface implemented by variants with an EncodeDefault tag', async () => {
    const { files } = await generate(shapes());
    const shape = model(files, 'Shape');
    expect(shape).toContain('@file:OptIn(ExperimentalSerializationApi::class)');
    expect(shape).toContain('@Serializable(with = Shape.Serializer::class)');
    expect(shape).toContain('public sealed interface Shape {');
    expect(shape).toContain('public data class Unknown(public val raw: JsonElement) : Shape');
    expect(shape).toContain('public object Serializer : KSerializer<Shape> {');
    expect(shape).toContain('SerialDescriptor("test.api.models.Shape", JsonElement.serializer().descriptor)');
    expect(shape).toContain('val input = decoder as? JsonDecoder ?: throw SerializationException(');
    expect(shape).toContain('val tag = ((element as? JsonObject)?.get("kind") as? JsonPrimitive)?.takeIf { it.isString }?.content');
    expect(shape).toContain('"circle" -> input.json.decodeFromJsonElement(test.api.models.Circle.serializer(), element)');
    expect(shape).toContain('"square" -> input.json.decodeFromJsonElement(test.api.models.Square.serializer(), element)');
    expect(shape).toContain('else -> Unknown(element)');
    expect(shape).toContain('val output = encoder as? JsonEncoder ?: throw SerializationException(');
    expect(shape).toContain('is test.api.models.Circle -> output.json.encodeToJsonElement(test.api.models.Circle.serializer(), value)');
    expect(shape).toContain('is Unknown -> value.raw');

    const circle = model(files, 'Circle');
    expect(circle).toContain('@file:OptIn(ExperimentalSerializationApi::class)');
    expect(squash(circle)).toContain(squash('@SerialName("kind") @EncodeDefault public val kind: String = "circle",'));
    expect(circle).toContain('public val radius: Double,');
    expect(circle).toContain(') : Shape');
    expect(squash(model(files, 'Square'))).toContain(squash('@EncodeDefault public val kind: SquareKind = SquareKind("square"),'));
  });

  it('lets one object implement two unions', async () => {
    const ir = pets();
    ir.schemas.set('Mixed', union([ref('Cat'), str]));
    const { files } = await generate(ir);
    expect(model(files, 'Cat')).toContain(') : Pet, Mixed');
    expect(model(files, 'Dog')).toContain(') : Pet');
  });

  it('renders untagged union trying variants in order with wrappers for primitives', async () => {
    const ir = pets();
    ir.schemas.set('Named', union([str, ref('Cat'), arr(ref('Cat')), obj([], { additionalProperties: int }), int, ref('Pet')]));
    const { files } = await generate(ir);
    const pet = model(files, 'Pet');
    const cat = pet.indexOf('if (element is JsonObject) attempt(input, test.api.models.Cat.serializer(), element)?.let { return it }');
    const dog = pet.indexOf('if (element is JsonObject) attempt(input, test.api.models.Dog.serializer(), element)?.let { return it }');
    expect(cat).toBeGreaterThan(-1);
    expect(dog).toBeGreaterThan(cat);
    expect(pet).toContain('return Unknown(element)');
    expect(pet).toContain('catch (e: IllegalArgumentException)');

    const named = model(files, 'Named');
    expect(named).toContain('public data class StringValue(public val value: String) : Named');
    expect(named).toContain('public data class CatList(public val value: List<test.api.models.Cat>) : Named');
    expect(named).toContain('public data class IntMap(public val value: Map<String, Int>) : Named');
    expect(named).toContain('public data class IntValue(public val value: Int) : Named');
    expect(named).toContain('public data class PetValue(public val value: test.api.models.Pet) : Named');
    expect(named).toContain('if (element is JsonPrimitive && element.isString) attempt(input, String.serializer(), element)?.let { return StringValue(it) }');
    expect(named).toContain('if (element is JsonArray) attempt(input, ListSerializer(test.api.models.Cat.serializer()), element)?.let { return CatList(it) }');
    expect(named).toContain('if (element is JsonPrimitive && !element.isString) attempt(input, Int.serializer(), element)?.let { return IntValue(it) }');
    expect(named).toContain('attempt(input, test.api.models.Pet.Serializer, element)?.let { return PetValue(it) }');
    expect(named).toContain('is StringValue -> output.json.encodeToJsonElement(String.serializer(), value.value)');
    expect(named).toContain('import kotlinx.serialization.builtins.ListSerializer');
    expect(model(files, 'Cat')).toContain(') : Pet, Named');
  });

  it('flattens cyclic untagged unions', async () => {
    const { files } = await generate(doc({ U1: union([ref('U2'), str]), U2: union([ref('U1'), int]) }));
    const u1 = model(files, 'U1');
    expect(u1).not.toContain('U2.Serializer');
    expect(u1).toContain('public data class StringValue(public val value: String) : U1');
    expect(u1).toContain('public data class IntValue(public val value: Int) : U1');
    expect(model(files, 'U2')).not.toContain('U1.Serializer');
  });

  it('fully qualifies model types inside union files', async () => {
    const { files } = await generate(
      doc({
        Thing: union([ref('Unknown'), ref('Serializer'), str]),
        Unknown: obj([prop('a', str, true)]),
        Serializer: obj([prop('b', str, true)]),
      }),
    );
    const thing = model(files, 'Thing');
    expect(thing).toContain('public data class Unknown(public val raw: JsonElement) : Thing');
    expect(thing).toContain('is test.api.models.Unknown -> output.json.encodeToJsonElement(test.api.models.Unknown.serializer(), value)');
    expect(thing).toContain('is test.api.models.Serializer -> output.json.encodeToJsonElement(test.api.models.Serializer.serializer(), value)');
    expect(model(files, 'Unknown')).toContain(') : Thing');
  });

  it('renders a union of string and an inline object', async () => {
    const { files } = await generate(doc({ Site: union([str, obj([prop('url', str, true)])]) }));
    expect(model(files, 'Site')).toContain('public data class StringValue(public val value: String) : Site');
    expect(model(files, 'SiteVariant2')).toContain(') : Site');
  });

  it('marks deprecated schemas and suppresses deprecation warnings per file', async () => {
    const { files } = await generate(
      doc({ Old: obj([prop('a', { ...str, deprecated: true }, false)], { deprecated: true, description: 'Costs $5 */ now' }), User: obj([prop('old', ref('Old'))]) }),
    );
    const old = model(files, 'Old');
    expect(squash(old)).toContain(squash('@Deprecated("Deprecated in the API.") @Serializable public data class Old('));
    expect(squash(old)).toContain(squash('@Deprecated("Deprecated in the API.") @SerialName("a") public val a: String? = null,'));
    expect(old).toContain('Costs $5 *&#47; now');
    expect(model(files, 'User')).toContain('@file:Suppress("DEPRECATION", "RedundantVisibilityModifier")');
  });

  it('applies a mapping serializer to model properties, nested ones included', async () => {
    const instant = { type: 'kotlinx.datetime.Instant', serializer: 'kotlinx.datetime.serializers.InstantIso8601Serializer' };
    const { files } = await generate(
      doc({ Event: obj([prop('at', dateTime, true), prop('ats', arr(dateTime)), prop('id', int, true)]) }),
      { typeMappings: { 'string:date-time': instant, integer: 'Long' } },
    );
    const event = model(files, 'Event');
    const annotated = '@Serializable(with = kotlinx.datetime.serializers.InstantIso8601Serializer::class) kotlinx.datetime.Instant';
    expect(event).toContain(`public val at: ${annotated},`);
    expect(event).toContain(`public val ats: List<${annotated}>? = null,`);
    // A mapping without an explicit serializer relies on the type being serializable itself.
    expect(event).toContain('public val id: Long,');
  });

  it('symbols.typeOf returns generated names', async () => {
    const { api } = await generate(doc({ 'pet-info': obj([prop('a', str)]) }));
    expect(api.symbols.typeOf('pet-info')).toEqual({ name: 'PetInfo', packageName: 'test.api.models', file: 'src/main/kotlin/test/api/models/PetInfo.kt' });
  });
});
