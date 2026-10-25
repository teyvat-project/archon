import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { kdoc, ktSource, literal } from './emit.js';
import type { KotlinPluginOptions } from './index.js';
import { ktIdentifier, packageDir, type KtNames } from './names.js';
import type { KtType, KtTypeResolver } from './types.js';
import { isDeclared } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

/**
 * One variant of a union. A named object implements the union's sealed interface itself (`direct`); anything else
 * is held by a nested wrapper class (`wrapper`).
 */
export type UnionVariant = { schema: IRSchema; type: KtType; direct?: string; wrapper?: string; guard?: string };

export type UnionPlan = {
  /** Union schema → its variants, in reading order (duplicates of one Kotlin type merged). */
  variants: Map<string, UnionVariant[]>;
  /** Object schema → the type names of the unions it implements. */
  implementsOf: Map<string, string[]>;
  /** Object schema → discriminator property (wire name) → the one tag its unions map it to. */
  tags: Map<string, Map<string, string>>;
};

export type EmittedModel = { path: string; content: string };

const DEPRECATED = '@Deprecated("Deprecated in the API.")';

/** Decides every union's variants, which objects implement which unions, and the tags objects default to. */
export function planUnions(ir: IRDocument, names: KtNames, resolver: KtTypeResolver): UnionPlan {
  const variants = new Map<string, UnionVariant[]>();
  const implementsOf = new Map<string, string[]>();
  const tagSets = new Map<string, Map<string, Set<string>>>();
  for (const [schemaName, schema] of ir.schemas) {
    if (schema.kind !== 'union') continue;
    const typeName = names.types.get(schemaName) as string;
    const namer = new UniqueNamer(['Unknown', 'Serializer', typeName]);
    const seen = new Set<string>();
    const list: UnionVariant[] = [];
    readVariants(schemaName, schema, resolver).forEach((variant, i) => {
      if (variant.kind === 'null' || (variant.kind === 'ref' && variant.name === schemaName)) return;
      const type = resolver.typeOf(variant, ['schemas', schemaName, 'variants', String(i)], { qualified: true });
      if (seen.has(type.code)) return;
      seen.add(type.code);
      const target = variant.kind === 'ref' ? resolver.schema(variant.name) : undefined;
      if (variant.kind === 'ref' && target?.kind === 'object' && isDeclared(target)) {
        list.push({ schema: variant, type, direct: variant.name, guard: 'element is JsonObject' });
        const unions = implementsOf.get(variant.name) ?? [];
        unions.push(typeName);
        implementsOf.set(variant.name, unions);
      } else {
        const base = /(?:List|Map)$/.test(type.friendly) ? type.friendly : `${type.friendly}Value`;
        list.push({ schema: variant, type, wrapper: namer.claim(base), guard: guardFor(type, target) });
      }
    });
    variants.set(schemaName, list);

    const discriminator = schema.discriminator;
    if (!discriminator) continue;
    for (const [tag, target] of discriminator.mapping) {
      if (!list.some((v) => v.direct === target)) continue;
      const byProperty = tagSets.get(target) ?? new Map<string, Set<string>>();
      const tags = byProperty.get(discriminator.property) ?? new Set<string>();
      tags.add(tag);
      byProperty.set(discriminator.property, tags);
      tagSets.set(target, byProperty);
    }
  }

  const tags = new Map<string, Map<string, string>>();
  for (const [objectName, byProperty] of tagSets) {
    const single = new Map<string, string>();
    for (const [property, set] of byProperty) if (set.size === 1) single.set(property, [...set][0] as string);
    tags.set(objectName, single);
  }
  return { variants, implementsOf, tags };
}

/**
 * The variants a union reads. In an untagged union, a variant that is itself an untagged union leading back to this
 * one (`U1 = U2 | string`, `U2 = U1 | int`) would make the serializers call each other on the same JSON forever, so
 * such a variant is replaced by its own variants (recursively, skipping the cycle).
 */
function readVariants(schemaName: string, schema: UnionSchema, resolver: KtTypeResolver): IRSchema[] {
  if (schema.discriminator) return schema.variants;
  const untagged = (s: IRSchema): UnionSchema | undefined => {
    if (s.kind !== 'ref') return undefined;
    const target = resolver.schema(s.name);
    return target?.kind === 'union' && !target.discriminator ? target : undefined;
  };
  const reaches = (from: string, seen: Set<string>): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    for (const v of untagged({ kind: 'ref', name: from, nullable: false })?.variants ?? []) {
      if (v.kind !== 'ref' || !untagged(v)) continue;
      if (v.name === schemaName || reaches(v.name, seen)) return true;
    }
    return false;
  };
  const expand = (variants: IRSchema[], visited: Set<string>): IRSchema[] =>
    variants.flatMap((v) => {
      const inner = untagged(v);
      if (v.kind !== 'ref' || inner === undefined) return [v];
      if (v.name === schemaName || visited.has(v.name)) return [];
      if (!reaches(v.name, new Set())) return [v];
      return expand(inner.variants, new Set(visited).add(v.name));
    });
  return expand(schema.variants, new Set([schemaName]));
}

/** The JSON shape a wrapper variant needs before it is tried (so `"1"` is not read as a number and so on). */
function guardFor(type: KtType, target: IRSchema | undefined): string | undefined {
  const string = 'element is JsonPrimitive && element.isString';
  const scalar = 'element is JsonPrimitive && !element.isString';
  if (target?.kind === 'enum') return target.base === 'string' ? string : scalar;
  if (type.code === 'String' || type.code === 'ApiFile') return string;
  if (['Int', 'Long', 'Double', 'Float', 'Boolean'].includes(type.code)) return scalar;
  if (type.code.startsWith('List<')) return 'element is JsonArray';
  if (type.code.startsWith('Map<')) return 'element is JsonObject';
  return undefined;
}

/** One file per declared named schema: `src/main/kotlin/<package>/models/<Type>.kt`. */
export function renderModels(
  ctx: PluginContext<KotlinPluginOptions>,
  names: KtNames,
  resolver: KtTypeResolver,
  plan: UnionPlan,
  runtimeNames: Iterable<string>,
): EmittedModel[] {
  const out: EmittedModel[] = [];
  const pkg = resolver.packageName;
  for (const [schemaName, schema] of ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    const typeName = names.types.get(schemaName) as string;
    const w = ctx.writer({ indent: '    ' });
    kdoc(w, schema.description);
    if (schema.deprecated) w.line(DEPRECATED);
    if (schema.kind === 'object') renderClass(w, { schemaName, schema, typeName, names, resolver, plan });
    else if (schema.kind === 'enum') renderEnum(w, schema, typeName, resolver);
    else if (schema.kind === 'union') renderUnion(w, { schemaName, schema: schema as UnionSchema, typeName }, resolver, plan);
    out.push({
      path: `${packageDir(pkg)}/models/${names.files.get(schemaName)}.kt`,
      content: ktSource(ctx, `${pkg}.models`, pkg, runtimeNames, w.toString()),
    });
  }
  return out;
}

function renderClass(
  w: CodeWriter,
  c: { schemaName: string; schema: ObjectSchema; typeName: string; names: KtNames; resolver: KtTypeResolver; plan: UnionPlan },
): void {
  const members = c.names.members(c.schemaName);
  const tags = c.plan.tags.get(c.schemaName);
  w.line('@Serializable');
  w.line(`public data class ${c.typeName}(`);
  w.indent(() => {
    for (const p of c.schema.properties) {
      const type = c.resolver.typeOf(p.schema, ['schemas', c.schemaName, 'properties', p.name]);
      const nullable = !p.required || c.resolver.isNullable(p.schema);
      const tag = tags?.get(p.name);
      const tagDefault = tag === undefined ? undefined : tagValue(tag, p.schema, type, c.resolver);
      const fallback = p.required ? '' : ' = null';
      kdoc(w, p.schema.description);
      if (p.schema.deprecated) w.line(DEPRECATED);
      w.line(`@SerialName(${literal(p.name)})`);
      if (tagDefault !== undefined) w.line('@EncodeDefault');
      w.line(`public val ${members.get(p.name)}: ${type.decl}${nullable ? '?' : ''}${tagDefault !== undefined ? ` = ${tagDefault}` : fallback},`);
    }
  });
  const unions = c.plan.implementsOf.get(c.schemaName) ?? [];
  w.line(unions.length > 0 ? `) : ${unions.join(', ')}` : ')');
}

/** The default for a discriminator property: the tag, as a string or as the string enum the property is. */
function tagValue(tag: string, schema: IRSchema, type: KtType, resolver: KtTypeResolver): string | undefined {
  if (type.code === 'String') return literal(tag);
  const target = schema.kind === 'ref' ? resolver.schema(schema.name) : undefined;
  if (target?.kind === 'enum' && target.base === 'string') return `${type.code}(${literal(tag)})`;
  return undefined;
}

function renderEnum(w: CodeWriter, schema: EnumSchema, typeName: string, resolver: KtTypeResolver): void {
  const valueType = schema.base === 'string' ? 'String' : schema.base === 'integer' ? 'Long' : 'Double';
  const kind = schema.base === 'string' ? 'STRING' : schema.base === 'integer' ? 'LONG' : 'DOUBLE';
  const lit = (v: string | number) => {
    if (valueType === 'String') return literal(String(v));
    if (valueType === 'Long') return `${v}L`;
    const text = String(v);
    return Number.isInteger(v) && !/e/i.test(text) ? `${text}.0` : text;
  };
  const namer = new UniqueNamer(['Serializer', 'value', 'isKnown', 'knownValues', 'Companion', typeName]);
  const members = schema.values.map((v) => ({ name: namer.claim(v === '' ? 'Empty' : ktIdentifier(String(v), 'PascalCase')), value: v }));

  w.line(`@Serializable(with = ${typeName}.Serializer::class)`);
  w.block(`public class ${typeName}(public val value: ${valueType}) {`, () => {
    w.line('/** Whether [value] is one of the values the API declared. */');
    if (members.length === 0) {
      w.line('public val isKnown: Boolean get() = false');
    } else {
      w.line('public val isKnown: Boolean');
      w.indent(() => {
        w.block('get() = when (value) {', () => {
          w.line(`${members.map((m) => lit(m.value)).join(', ')} -> true`);
          w.line('else -> false');
        });
      });
    }
    w.blank();
    w.line(`override fun equals(other: Any?): Boolean = other is ${typeName} && other.value == value`);
    w.blank();
    w.line('override fun hashCode(): Int = value.hashCode()');
    w.blank();
    w.line(`override fun toString(): String = ${valueType === 'String' ? 'value' : 'value.toString()'}`);
    w.blank();
    w.block('public companion object {', () => {
      for (const m of members) w.line(`public val ${m.name}: ${typeName} = ${typeName}(${lit(m.value)})`);
      if (members.length > 0) w.blank();
      w.line('/** The values the API declared. */');
      w.line(`public val knownValues: List<${typeName}> = ${members.length === 0 ? 'emptyList()' : `listOf(${members.map((m) => m.name).join(', ')})`}`);
    });
    w.blank();
    w.block(`public object Serializer : KSerializer<${typeName}> {`, () => {
      w.line(`override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(${literal(`${resolver.packageName}.models.${typeName.replace(/`/g, '')}`)}, PrimitiveKind.${kind})`);
      w.blank();
      w.block(`override fun serialize(encoder: Encoder, value: ${typeName}) {`, () => {
        w.line(`encoder.encode${valueType}(value.value)`);
      });
      w.blank();
      w.line(`override fun deserialize(decoder: Decoder): ${typeName} = ${typeName}(decoder.decode${valueType}())`);
    });
  });
}

function renderUnion(w: CodeWriter, u: { schemaName: string; schema: UnionSchema; typeName: string }, resolver: KtTypeResolver, plan: UnionPlan): void {
  const { schema, typeName } = u;
  const variants = plan.variants.get(u.schemaName) ?? [];
  const fqn = `${resolver.packageName}.models.${typeName.replace(/`/g, '')}`;
  const wrap = (v: UnionVariant, expr: string) => (v.wrapper ? `${v.wrapper}(${expr})` : expr);

  w.line(`@Serializable(with = ${typeName}.Serializer::class)`);
  w.block(`public sealed interface ${typeName} {`, () => {
    const wrappers = variants.filter((v) => v.wrapper !== undefined);
    for (const v of wrappers) w.line(`public data class ${v.wrapper}(public val value: ${v.type.code}) : ${typeName}`);
    if (wrappers.length > 0) w.blank();
    w.line('/** A value no variant matched, kept as raw JSON. */');
    w.line(`public data class Unknown(public val raw: JsonElement) : ${typeName}`);
    w.blank();
    w.block(`public object Serializer : KSerializer<${typeName}> {`, () => {
      w.line(`override val descriptor: SerialDescriptor = SerialDescriptor(${literal(fqn)}, JsonElement.serializer().descriptor)`);
      w.blank();
      w.block(`override fun deserialize(decoder: Decoder): ${typeName} {`, () => {
        w.line(`val input = decoder as? JsonDecoder ?: throw SerializationException(${literal(`${typeName.replace(/`/g, '')} can be read from JSON only.`)})`);
        w.line('val element = input.decodeJsonElement()');
        const discriminator = schema.discriminator;
        if (discriminator) {
          const branches = [...discriminator.mapping].flatMap(([tag, target]) => {
            const v = variants.find((x) => x.schema.kind === 'ref' && x.schema.name === target);
            return v ? [`${literal(tag)} -> ${wrap(v, `input.json.decodeFromJsonElement(${v.type.serializer}, element)`)}`] : [];
          });
          if (branches.length === 0) {
            w.line('return Unknown(element)');
          } else {
            w.line(`val tag = ((element as? JsonObject)?.get(${literal(discriminator.property)}) as? JsonPrimitive)?.takeIf { it.isString }?.content`);
            w.block('return when (tag) {', () => {
              for (const b of branches) w.line(b);
              w.line('else -> Unknown(element)');
            });
          }
        } else {
          for (const v of variants) {
            const attempt = `attempt(input, ${v.type.serializer}, element)?.let { return ${v.wrapper ? `${v.wrapper}(it)` : 'it'} }`;
            w.line(v.guard ? `if (${v.guard}) ${attempt}` : attempt);
          }
          w.line('return Unknown(element)');
        }
      });
      w.blank();
      w.block(`override fun serialize(encoder: Encoder, value: ${typeName}) {`, () => {
        w.line(`val output = encoder as? JsonEncoder ?: throw SerializationException(${literal(`${typeName.replace(/`/g, '')} can be written to JSON only.`)})`);
        w.block('val element = when (value) {', () => {
          for (const v of variants) {
            w.line(
              v.wrapper
                ? `is ${v.wrapper} -> output.json.encodeToJsonElement(${v.type.serializer}, value.value)`
                : `is ${v.type.code} -> output.json.encodeToJsonElement(${v.type.serializer}, value)`,
            );
          }
          w.line('is Unknown -> value.raw');
        });
        w.line('output.encodeJsonElement(element)');
      });
      if (!schema.discriminator && variants.length > 0) {
        w.blank();
        w.line('/** The variant read with [serializer], or `null` when the JSON does not fit it. */');
        w.line('private fun <T> attempt(input: JsonDecoder, serializer: KSerializer<T>, element: JsonElement): T? =');
        w.indent(() => {
          w.block('try {', () => w.line('input.json.decodeFromJsonElement(serializer, element)'), '} catch (e: IllegalArgumentException) {');
          w.indent(() => w.line('null'));
          w.line('}');
        });
      }
    });
  });
}
