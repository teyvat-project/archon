import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { csFile, G, GEN, literal, SER, STJ, summary } from './emit.js';
import type { CSharpPluginOptions } from './index.js';
import { csIdentifier, fileBaseName, type CsNames } from './names.js';
import type { CsType, CsTypeResolver } from './types.js';
import { isDeclared } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

export type UnionPlan = {
  /** Unions emitted as `[JsonPolymorphic]` bases: discriminator property and tag → variant schema. */
  polymorphic: Map<string, { property: string; variants: Map<string, string> }>;
  /** Variant schema → its polymorphic base. */
  baseOf: Map<string, string>;
};

export type EmittedModel = { path: string; content: string };

/**
 * Picks the discriminated unions that can be `[JsonPolymorphic]` bases: every variant is a non-nullable ref to a
 * named object, the mapping covers each variant exactly once, and no variant belongs to another such union
 * (C# has single inheritance).
 */
export function planUnions(ir: IRDocument): UnionPlan {
  const candidates = new Map<string, { property: string; variants: Map<string, string> }>();
  for (const [name, schema] of ir.schemas) {
    if (schema.kind !== 'union' || !schema.discriminator) continue;
    const variantNames = schema.variants.map((v) => (v.kind === 'ref' && !v.nullable ? v.name : undefined));
    if (variantNames.some((v) => v === undefined || !isObjectClass(ir.schemas.get(v)))) continue;
    const targets = [...schema.discriminator.mapping.values()];
    const unique = new Set(targets);
    if (unique.size !== targets.length || unique.size !== new Set(variantNames).size) continue;
    if (![...unique].every((t) => variantNames.includes(t))) continue;
    candidates.set(name, { property: schema.discriminator.property, variants: new Map(schema.discriminator.mapping) });
  }

  const membership = new Map<string, number>();
  for (const { variants } of candidates.values()) {
    for (const v of variants.values()) membership.set(v, (membership.get(v) ?? 0) + 1);
  }
  const polymorphic = new Map<string, { property: string; variants: Map<string, string> }>();
  const baseOf = new Map<string, string>();
  for (const [name, plan] of candidates) {
    if ([...plan.variants.values()].some((v) => membership.get(v) !== 1)) continue;
    polymorphic.set(name, plan);
    for (const v of plan.variants.values()) baseOf.set(v, name);
  }
  return { polymorphic, baseOf };
}

function isObjectClass(schema: IRSchema | undefined): boolean {
  return schema?.kind === 'object' && schema.properties.length > 0;
}

/** One file per declared named schema: `Models/<Type>.cs`. */
export function renderModels(
  ctx: PluginContext<CSharpPluginOptions>,
  names: CsNames,
  resolver: CsTypeResolver,
  plan: UnionPlan,
  fileFieldSchemas: ReadonlySet<string>,
): EmittedModel[] {
  const out: EmittedModel[] = [];
  for (const [schemaName, schema] of ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    const typeName = names.types.get(schemaName) as string;
    const w = csFile(ctx, resolver.namespace);
    const path = ['schemas', schemaName];
    summary(w, schema.description);
    if (schema.deprecated) w.line(`[${G}.Obsolete]`);
    if (schema.kind === 'object') {
      renderClass(w, { schemaName, schema, typeName, names, resolver, plan, fileFields: fileFieldSchemas.has(schemaName) });
    } else if (schema.kind === 'enum') {
      renderEnum(w, schema, typeName);
    } else if (schema.kind === 'union') {
      const poly = plan.polymorphic.get(schemaName);
      if (poly) renderPolymorphicBase(w, typeName, poly, names);
      else renderWrapper(w, schema as UnionSchema, typeName, path, names, resolver);
    }
    out.push({ path: `Models/${fileBaseName(typeName, ctx.options)}.cs`, content: w.toString() });
  }
  return out;
}

function renderClass(
  w: CodeWriter,
  c: { schemaName: string; schema: ObjectSchema; typeName: string; names: CsNames; resolver: CsTypeResolver; plan: UnionPlan; fileFields: boolean },
): void {
  const base = c.plan.baseOf.get(c.schemaName);
  const dropped = base !== undefined ? c.plan.polymorphic.get(base)?.property : undefined;
  const members = c.names.members(c.schemaName);
  const isBase = c.plan.polymorphic.has(c.schemaName);
  const baseName = base !== undefined ? c.names.types.get(base) : undefined;
  w.block(`public ${isBase ? '' : 'sealed '}partial class ${c.typeName}${baseName ? ` : ${baseName}` : ''}`, () => {
    let first = true;
    for (const p of c.schema.properties) {
      if (p.name === dropped) continue;
      if (!first) w.blank();
      first = false;
      const type = c.resolver.typeOf(p.schema, ['schemas', c.schemaName, 'properties', p.name], 'model');
      const nullable = !p.required || c.resolver.isNullable(p.schema);
      summary(w, p.schema.description);
      if (p.schema.deprecated) w.line(`[${G}.Obsolete]`);
      w.line(`[${SER}.JsonPropertyName(${literal(p.name)})]`);
      if (c.fileFields && isFileType(type, c.resolver)) w.line(`[${SER}.JsonIgnore]`);
      else if (!p.required) w.line(`[${SER}.JsonIgnore(Condition = ${SER}.JsonIgnoreCondition.WhenWritingNull)]`);
      w.line(`public ${p.required ? 'required ' : ''}${c.resolver.nullableCode(type, nullable)} ${members.get(p.name)} { get; set; }`);
    }
    // A derived variant inherits the base's extension data.
    if (c.schema.additionalProperties !== undefined && c.schema.additionalProperties !== false && base === undefined) {
      if (!first) w.blank();
      w.line(`[${SER}.JsonExtensionData]`);
      w.line(`public ${GEN}.Dictionary<string, ${STJ}.JsonElement>? AdditionalProperties { get; set; }`);
    }
  });
}

/** `ApiFile` and lists of it: multipart file parts, sent separately from the JSON fields. */
export function isFileType(type: CsType, resolver: CsTypeResolver): boolean {
  const file = `${resolver.core}.ApiFile`;
  return type.code === file || type.code === `${GEN}.List<${file}>`;
}

function renderEnum(w: CodeWriter, schema: EnumSchema, typeName: string): void {
  const valueType = schema.base === 'string' ? 'string' : schema.base === 'integer' ? 'long' : 'double';
  const isString = valueType === 'string';
  const lit = (v: string | number) => (isString ? literal(String(v)) : String(v));
  const namer = new UniqueNamer(['Value', 'IsKnown', 'KnownValues', 'Equals', 'GetHashCode', 'ToString', 'GetType', typeName]);
  const members = schema.values.map((v) => ({ name: namer.claim(enumMemberBase(v)), value: v }));
  const converter = `${typeName}JsonConverter`;

  w.line(`[${SER}.JsonConverter(typeof(${converter}))]`);
  w.block(`public readonly partial struct ${typeName} : ${G}.IEquatable<${typeName}>`, () => {
    w.block(`public ${typeName}(${valueType} value)`, () => {
      w.line(isString ? `Value = value ?? throw new ${G}.ArgumentNullException(nameof(value));` : 'Value = value;');
    });
    w.blank();
    w.line('/// <summary>The raw value (known or not).</summary>');
    w.line(`public ${valueType} Value { get; }`);
    w.blank();
    for (const m of members) w.line(`public static ${typeName} ${m.name} { get; } = new(${lit(m.value)});`);
    if (members.length > 0) w.blank();
    w.line(`public static ${GEN}.IReadOnlyList<${typeName}> KnownValues { get; } = [${members.map((m) => m.name).join(', ')}];`);
    w.blank();
    w.line('/// <summary>Whether <see cref="Value"/> is one of the values the API declared.</summary>');
    w.line(
      members.length === 0
        ? 'public bool IsKnown => false;'
        : `public bool IsKnown => Value switch { ${members.map((m) => lit(m.value)).join(' or ')} => true, _ => false };`,
    );
    w.blank();
    w.line(
      isString
        ? `public bool Equals(${typeName} other) => string.Equals(Value, other.Value, ${G}.StringComparison.Ordinal);`
        : `public bool Equals(${typeName} other) => Value.Equals(other.Value);`,
    );
    w.blank();
    w.line(`public override bool Equals(object? obj) => obj is ${typeName} other && Equals(other);`);
    w.blank();
    w.line(isString ? `public override int GetHashCode() => Value is null ? 0 : ${G}.StringComparer.Ordinal.GetHashCode(Value);` : 'public override int GetHashCode() => Value.GetHashCode();');
    w.blank();
    w.line(
      isString
        ? 'public override string ToString() => Value ?? "";'
        : `public override string ToString() => Value.ToString(${valueType === 'double' ? '"R", ' : ''}${G}.Globalization.CultureInfo.InvariantCulture);`,
    );
    w.blank();
    w.line(`public static bool operator ==(${typeName} left, ${typeName} right) => left.Equals(right);`);
    w.blank();
    w.line(`public static bool operator !=(${typeName} left, ${typeName} right) => !left.Equals(right);`);
    w.blank();
    w.line(`public static implicit operator ${typeName}(${valueType} value) => new(value);`);
  });
  w.blank();
  w.block(`internal sealed class ${converter} : ${SER}.JsonConverter<${typeName}>`, () => {
    const read = isString ? 'reader.GetString()!' : valueType === 'long' ? 'reader.GetInt64()' : 'reader.GetDouble()';
    w.line(`public override ${typeName} Read(ref ${STJ}.Utf8JsonReader reader, ${G}.Type typeToConvert, ${STJ}.JsonSerializerOptions options)`);
    w.line(`    => new(${read});`);
    w.blank();
    w.line(`public override void Write(${STJ}.Utf8JsonWriter writer, ${typeName} value, ${STJ}.JsonSerializerOptions options)`);
    w.line(`    => writer.${isString ? 'WriteStringValue' : 'WriteNumberValue'}(value.Value);`);
  });
}

function enumMemberBase(value: string | number): string {
  if (value === '') return 'Empty';
  return csIdentifier(String(value), 'PascalCase');
}

function renderPolymorphicBase(w: CodeWriter, typeName: string, plan: { property: string; variants: Map<string, string> }, names: CsNames): void {
  w.line(`[${SER}.JsonPolymorphic(TypeDiscriminatorPropertyName = ${literal(plan.property)}, IgnoreUnrecognizedTypeDiscriminators = true)]`);
  for (const [tag, variant] of plan.variants) w.line(`[${SER}.JsonDerivedType(typeof(${names.types.get(variant)}), ${literal(tag)})]`);
  w.block(`public partial class ${typeName}`, () => {
    w.line('/// <summary>');
    w.line(`/// Properties not mapped to members. An object whose <c>${plan.property}</c> is not a known value is read as a`);
    w.line(`/// plain <see cref="${typeName}"/> with all its other properties here (the unknown value itself is not kept).`);
    w.line('/// </summary>');
    w.line(`[${SER}.JsonExtensionData]`);
    w.line(`public ${GEN}.Dictionary<string, ${STJ}.JsonElement>? AdditionalProperties { get; set; }`);
  });
}

function renderWrapper(w: CodeWriter, schema: UnionSchema, typeName: string, path: string[], names: CsNames, resolver: CsTypeResolver): void {
  const accessors = new UniqueNamer(['Value', 'Unknown', 'FromUnknown', 'Equals', 'GetHashCode', 'ToString', 'GetType', typeName]);
  const seen = new Set<string>();
  const variants: { type: CsType; accessor: string; schema: IRSchema }[] = [];
  schema.variants.forEach((variant, i) => {
    const type = resolver.typeOf(variant, [...path, 'variants', String(i)], 'model');
    if (type.code === typeName || seen.has(type.code)) return;
    seen.add(type.code);
    resolver.register(type);
    variants.push({ type, accessor: accessors.claim(type.friendly), schema: variant });
  });
  const converter = `${typeName}JsonConverter`;
  const info = (t: CsType) => `(${STJ}.Serialization.Metadata.JsonTypeInfo<${t.code}>)options.GetTypeInfo(typeof(${t.code}))`;

  w.line(`[${SER}.JsonConverter(typeof(${converter}))]`);
  w.block(`public sealed partial class ${typeName}`, () => {
    w.line('private readonly object? _value;');
    w.blank();
    w.block(`private ${typeName}(object? value, ${STJ}.JsonElement? unknown)`, () => {
      w.line('_value = value;');
      w.line('Unknown = unknown;');
    });
    for (const v of variants) {
      w.blank();
      const arg = v.type.valueType ? 'value' : `(object)value ?? throw new ${G}.ArgumentNullException(nameof(value))`;
      w.line(`public ${typeName}(${v.type.code} value)`);
      w.line(`    : this(${arg}, null)`);
      w.line('{');
      w.line('}');
      w.blank();
      w.line(`public static implicit operator ${typeName}(${v.type.code} value) => new(value);`);
    }
    w.blank();
    w.line('/// <summary>The variant value, or <c>null</c> when no variant matched (see <see cref="Unknown"/>).</summary>');
    w.line('public object? Value => _value;');
    w.blank();
    w.line('/// <summary>The raw JSON when no variant matched.</summary>');
    w.line(`public ${STJ}.JsonElement? Unknown { get; }`);
    for (const v of variants) {
      w.blank();
      w.line(
        v.type.valueType
          ? `public ${v.type.code}? ${v.accessor} => _value is ${v.type.code} v ? v : null;`
          : `public ${v.type.code}? ${v.accessor} => _value as ${v.type.code};`,
      );
    }
    w.blank();
    w.line(`public static ${typeName} FromUnknown(${STJ}.JsonElement raw) => new(null, raw.Clone());`);
  });
  w.blank();
  w.block(`internal sealed class ${converter} : ${SER}.JsonConverter<${typeName}>`, () => {
    w.block(`public override ${typeName}? Read(ref ${STJ}.Utf8JsonReader reader, ${G}.Type typeToConvert, ${STJ}.JsonSerializerOptions options)`, () => {
      w.line(`using var document = ${STJ}.JsonDocument.ParseValue(ref reader);`);
      w.line('var element = document.RootElement;');
      const discriminator = schema.discriminator;
      if (discriminator) {
        const kind = `${STJ}.JsonValueKind`;
        w.block(
          `if (element.ValueKind == ${kind}.Object && element.TryGetProperty(${literal(discriminator.property)}, out var tag) && tag.ValueKind == ${kind}.String)`,
          () => {
            w.block('switch (tag.GetString())', () => {
              for (const [tag, target] of discriminator.mapping) {
                const t = resolver.typeOf({ kind: 'ref', name: target, nullable: false }, path, 'model');
                if (!variants.some((v) => v.type.code === t.code)) continue;
                w.line(`case ${literal(tag)}:`);
                w.line(`    return new ${typeName}(${STJ}.JsonSerializer.Deserialize(element, ${info(t)})!);`);
              }
            });
          },
        );
      } else {
        for (const v of variants) {
          w.block('try', () => {
            w.line(`return new ${typeName}(${STJ}.JsonSerializer.Deserialize(element, ${info(v.type)})!);`);
          });
          w.block(`catch (${STJ}.JsonException)`, () => {
            w.line('// not this variant');
          });
        }
      }
      w.line(`return ${typeName}.FromUnknown(element);`);
    });
    w.blank();
    w.block(`public override void Write(${STJ}.Utf8JsonWriter writer, ${typeName} value, ${STJ}.JsonSerializerOptions options)`, () => {
      w.block('switch (value.Value)', () => {
        for (const v of variants) {
          w.line(`case ${v.type.code} v:`);
          w.line(`    ${STJ}.JsonSerializer.Serialize(writer, v, ${info(v.type)});`);
          w.line('    return;');
        }
      });
      w.line('if (value.Unknown is { } raw) raw.WriteTo(writer);');
      w.line('else writer.WriteNullValue();');
    });
  });
}
