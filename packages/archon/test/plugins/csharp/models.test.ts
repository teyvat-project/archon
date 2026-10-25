import { describe, expect, it } from 'vitest';
import { arr, date, doc, enumOf, file, G, GEN, generate, int, nullable, obj, prop, ref, SER, squash, str, STJ, union } from './helpers.js';

const shapes = () =>
  doc({
    Shape: union([ref('Circle'), ref('Square')], { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } }),
    Circle: obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('radius', { kind: 'number', nullable: false }, true)]),
    Square: obj([prop('kind', enumOf(['square']), true), prop('side', { kind: 'number', nullable: false }, true)]),
  });

describe('csharp plugin: models', () => {
  it('renders required, optional and nullable properties with JsonPropertyName', async () => {
    const { files } = await generate(
      doc({
        Pet: obj(
          [prop('name', str, true), prop('note', str), prop('count', int), prop('parentId', nullable(str), true), prop('born', date)],
          { description: 'A <pet> & friend.' },
        ),
      }),
      { namespace: 'Test.Api' },
    );
    const pet = file(files, 'Models/Pet.cs');
    expect(pet.startsWith('// Generated header\n')).toBe(true);
    expect(pet).toContain('#nullable enable');
    expect(pet).toContain('namespace Test.Api;');
    expect(pet).toContain('/// A &lt;pet&gt; &amp; friend.');
    expect(pet).toContain('public sealed partial class Pet');
    expect(squash(pet)).toContain(squash(`[${SER}.JsonPropertyName("name")]
      public required string Name { get; set; }`));
    expect(squash(pet)).toContain(squash(`[${SER}.JsonPropertyName("note")]
      [${SER}.JsonIgnore(Condition = ${SER}.JsonIgnoreCondition.WhenWritingNull)]
      public string? Note { get; set; }`));
    expect(pet).toContain('public int? Count { get; set; }');
    expect(squash(pet)).toContain(squash(`[${SER}.JsonPropertyName("parentId")]
      public required string? ParentId { get; set; }`));
    expect(pet).toContain(`public ${G}.DateOnly? Born { get; set; }`);
  });

  it('renders self-referencing schema by name', async () => {
    const { files } = await generate(doc({ Node: obj([prop('children', arr(ref('Node')), true)]) }));
    expect(file(files, 'Models/Node.cs')).toContain(`public required ${GEN}.List<Node> Children { get; set; }`);
  });

  it('adds extension data when an object has properties and additionalProperties', async () => {
    const { files } = await generate(doc({ Bag: obj([prop('a', str)], { additionalProperties: str }) }));
    expect(squash(file(files, 'Models/Bag.cs'))).toContain(
      squash(`[${SER}.JsonExtensionData] public ${GEN}.Dictionary<string, ${STJ}.JsonElement>? AdditionalProperties { get; set; }`),
    );
  });

  it('renders extensible enum struct with known values and converter', async () => {
    const { files } = await generate(doc({ Status: enumOf(['active', 'in-active', 'value']), Priority: enumOf([1, 2], 'integer') }));
    const status = file(files, 'Models/Status.cs');
    expect(status).toContain(`[${SER}.JsonConverter(typeof(StatusJsonConverter))]`);
    expect(status).toContain(`public readonly partial struct Status : ${G}.IEquatable<Status>`);
    expect(status).toContain('public string Value { get; }');
    expect(status).toContain('public static Status Active { get; } = new("active");');
    expect(status).toContain('public static Status InActive { get; } = new("in-active");');
    expect(status).toContain('public static Status Value2 { get; } = new("value");');
    expect(status).toContain('public bool IsKnown => Value switch { "active" or "in-active" or "value" => true, _ => false };');
    expect(status).toContain('public override string ToString() => Value ?? "";');
    expect(status).toContain('public static implicit operator Status(string value) => new(value);');
    expect(status).toContain(`internal sealed class StatusJsonConverter : ${SER}.JsonConverter<Status>`);
    expect(status).toContain('writer.WriteStringValue(value.Value);');

    const priority = file(files, 'Models/Priority.cs');
    expect(priority).toContain('public long Value { get; }');
    expect(priority).toContain('public static Priority _1 { get; } = new(1);');
    expect(priority).toContain('reader.GetInt64()');
    expect(priority).toContain('writer.WriteNumberValue(value.Value);');
  });

  it('renders polymorphic base and derived variants without the discriminator property', async () => {
    const { files } = await generate(shapes());
    const shape = file(files, 'Models/Shape.cs');
    expect(shape).toContain(`[${SER}.JsonPolymorphic(TypeDiscriminatorPropertyName = "kind", IgnoreUnrecognizedTypeDiscriminators = true)]`);
    expect(shape).toContain(`[${SER}.JsonDerivedType(typeof(Circle), "circle")]`);
    expect(shape).toContain(`[${SER}.JsonDerivedType(typeof(Square), "square")]`);
    expect(shape).toContain('public partial class Shape');
    expect(shape).toContain('AdditionalProperties');
    const circle = file(files, 'Models/Circle.cs');
    expect(circle).toContain('public sealed partial class Circle : Shape');
    expect(circle).toContain('public required double Radius { get; set; }');
    expect(circle).not.toContain('Kind');
    expect(circle).not.toContain('AdditionalProperties');
    expect(file(files, 'Models/Square.cs')).not.toContain(' Kind ');
  });

  it('falls back to a wrapper converter when a variant belongs to two unions', async () => {
    const ir = shapes();
    ir.schemas.set('Round', union([ref('Circle')], { property: 'kind', mapping: { circle: 'Circle' } }));
    const { files } = await generate(ir);
    const shape = file(files, 'Models/Shape.cs');
    expect(shape).not.toContain('JsonPolymorphic');
    expect(shape).toContain(`[${SER}.JsonConverter(typeof(ShapeJsonConverter))]`);
    expect(shape).toContain('case "circle":');
    expect(file(files, 'Models/Circle.cs')).toContain('public required string Kind { get; set; }');
  });

  it('renders untagged union wrapper with accessors and try-in-order converter', async () => {
    const { files } = await generate(
      doc({
        Pet: union([ref('Cat'), ref('Dog')]),
        Cat: obj([prop('meows', { kind: 'boolean', nullable: false }, true)]),
        Dog: obj([prop('barks', { kind: 'boolean', nullable: false }, true)]),
      }),
    );
    const pet = file(files, 'Models/Pet.cs');
    expect(pet).toContain(`[${SER}.JsonConverter(typeof(PetJsonConverter))]`);
    expect(pet).toContain('public sealed partial class Pet');
    expect(pet).toContain('public Pet(Cat value)');
    expect(pet).toContain('public static implicit operator Pet(Cat value) => new(value);');
    expect(pet).toContain('public Cat? Cat => _value as Cat;');
    expect(pet).toContain('public Dog? Dog => _value as Dog;');
    expect(pet).toContain(`public ${STJ}.JsonElement? Unknown { get; }`);
    expect(pet).toContain('public object? Value => _value;');
    const cat = pet.indexOf('typeof(Cat)');
    const dog = pet.indexOf('typeof(Dog)');
    expect(cat).toBeGreaterThan(-1);
    expect(dog).toBeGreaterThan(cat);
    expect(pet).toContain(`catch (${STJ}.JsonException)`);
    expect(pet).toContain('return Pet.FromUnknown(element);');
  });

  it('flattens a union variant that refers back to the union, so reading cannot recurse forever', async () => {
    const { files } = await generate(doc({ U1: union([ref('U2'), str]), U2: union([ref('U1'), int]) }));
    const u1 = file(files, 'Models/U1.cs');
    expect(u1).not.toContain('typeof(U2)');
    expect(u1).toContain('public string? String => _value as string;');
    expect(u1).toContain('public int? Int => _value as int?;');
    expect(file(files, 'Models/U2.cs')).not.toContain('typeof(U1)');
  });

  it('writes a derived variant before its polymorphic base', async () => {
    const ir = shapes();
    ir.schemas.set('Mixed', union([ref('Shape'), ref('Circle')]));
    const { files } = await generate(ir);
    const mixed = file(files, 'Models/Mixed.cs');
    expect(mixed.indexOf('case Circle v:')).toBeGreaterThan(-1);
    expect(mixed.indexOf('case Circle v:')).toBeLessThan(mixed.indexOf('case Shape v:'));
    // a variant is written through its polymorphic base so the discriminator is kept
    expect(squash(mixed)).toContain(
      squash(`case Circle v: ${STJ}.JsonSerializer.Serialize<Shape>(writer, v, (${STJ}.Serialization.Metadata.JsonTypeInfo<Shape>)options.GetTypeInfo(typeof(Shape)));`),
    );
  });

  it('renders a union of string and object', async () => {
    const { files } = await generate(doc({ Site: union([str, obj([prop('url', str, true)])]) }));
    const site = file(files, 'Models/Site.cs');
    expect(site).toContain('public string? String => _value as string;');
    expect(site).toContain('public SiteVariant2? SiteVariant2 => _value as SiteVariant2;');
    expect(files.has('Models/SiteVariant2.cs')).toBe(true);
  });

  it('names hoisted inline unions and value-type accessors', async () => {
    const { files } = await generate(doc({ Holder: obj([prop('either', union([int, str]))]) }));
    expect(file(files, 'Models/Holder.cs')).toContain('public HolderEither? Either { get; set; }');
    expect(file(files, 'Models/HolderEither.cs')).toContain('public int? Int => _value as int?;');
  });

  it('marks deprecated schemas Obsolete and escapes XML doc', async () => {
    const { files } = await generate(doc({ Old: obj([prop('a', str, false)], { deprecated: true, description: 'a <b>' }) }));
    const old = file(files, 'Models/Old.cs');
    expect(old).toContain('[global::System.Obsolete]');
    expect(old).toContain('#pragma warning disable CS0612, CS0618');
    expect(old).toContain('/// a &lt;b&gt;');
  });

  it('JSON context registers models and parameter types with stable names', async () => {
    const { files } = await generate(doc({ Pet: obj([prop('a', str)]), Status: enumOf(['a']) }), { namespace: 'Test.Api' });
    const context = file(files, 'ApiJsonContext.cs');
    expect(context).toContain(`[${SER}.JsonSourceGenerationOptions(AllowOutOfOrderMetadataProperties = true)]`);
    expect(context).toContain(`[${SER}.JsonSerializable(typeof(Pet), TypeInfoPropertyName = "Pet")]`);
    expect(context).toContain(`[${SER}.JsonSerializable(typeof(Status), TypeInfoPropertyName = "Status")]`);
    expect(context).toContain(`public partial class ApiJsonContext : ${SER}.JsonSerializerContext`);
  });

  it('symbols.typeOf returns generated names', async () => {
    const { api } = await generate(doc({ 'pet-info': obj([prop('a', str)]) }), { namespace: 'Test.Api' });
    expect(api.symbols.typeOf('pet-info')).toEqual({ name: 'PetInfo', namespace: 'Test.Api', file: 'Models/PetInfo.cs' });
  });
});
