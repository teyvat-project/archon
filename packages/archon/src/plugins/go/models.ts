import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import type { Row } from './align.js';
import { doc, docRows, goSource, goString, isValidTagName, writeRows } from './emit.js';
import type { GoPluginOptions } from './index.js';
import { exported, goIdentifier, type GoNames } from './names.js';
import { isDeclared, type GoType, type GoTypeResolver } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

/** One variant of a union: a pointer field of the union struct. */
export type UnionVariant = { schema: IRSchema; type: GoType; field: string };

export type ModelPlan = {
  /** Union schema → its variants, in reading order (duplicates of one Go type merged). */
  variants: Map<string, UnionVariant[]>;
  /** Object schema → discriminator property (wire name) → the one tag its unions map it to. */
  tags: Map<string, Map<string, string>>;
  /** `<object>\0<property>` of required struct fields that must be pointers (they close a cycle of value fields). */
  pointerFields: Set<string>;
};

export type EmittedModel = { path: string; content: string };

export const DEPRECATED = 'Deprecated: Deprecated in the API.';

/** A doc text followed by the deprecation paragraph when `deprecated`. */
export function withDeprecation(text: string | undefined, deprecated: boolean | undefined): string | undefined {
  if (!deprecated) return text;
  return text === undefined || text.trim() === '' ? DEPRECATED : `${text}\n\n${DEPRECATED}`;
}

/** Decides every union's variants, the tags objects default to, and which value fields become pointers. */
export function planModels(ir: IRDocument, names: GoNames, resolver: GoTypeResolver): ModelPlan {
  const variants = new Map<string, UnionVariant[]>();
  const tagSets = new Map<string, Map<string, Set<string>>>();
  for (const [schemaName, schema] of ir.schemas) {
    if (schema.kind !== 'union') continue;
    const namer = new UniqueNamer(['Raw', 'MarshalJSON', 'UnmarshalJSON']);
    const seen = new Set<string>();
    const list: UnionVariant[] = [];
    readVariants(schemaName, schema, resolver).forEach((variant, i) => {
      if (variant.kind === 'null' || (variant.kind === 'ref' && variant.name === schemaName)) return;
      const type = resolver.typeOf(variant, ['schemas', schemaName, 'variants', String(i)]);
      if (seen.has(type.code)) return;
      seen.add(type.code);
      list.push({ schema: variant, type, field: namer.claim(exported(type.friendly)) });
    });
    variants.set(schemaName, list);

    const discriminator = schema.discriminator;
    if (!discriminator) continue;
    for (const [tag, target] of discriminator.mapping) {
      if (!list.some((v) => v.schema.kind === 'ref' && v.schema.name === target && resolver.objectTarget(v.schema) === target)) continue;
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
  return { variants, tags, pointerFields: pointerFields(ir, resolver) };
}

/**
 * Required, non-nullable fields of a named object type are values, but Go rejects a struct that contains itself:
 * an edge `A.p → B` whose target leads back to `A` through such value fields is made a pointer.
 */
function pointerFields(ir: IRDocument, resolver: GoTypeResolver): Set<string> {
  const edges = new Map<string, { property: string; target: string }[]>();
  for (const [name, schema] of ir.schemas) {
    if (schema.kind !== 'object' || !isDeclared(schema)) continue;
    const out: { property: string; target: string }[] = [];
    for (const p of schema.properties) {
      if (!p.required || resolver.isNullable(p.schema)) continue;
      const target = resolver.objectTarget(p.schema);
      if (target !== undefined) out.push({ property: p.name, target });
    }
    edges.set(name, out);
  }
  const reaches = (from: string, to: string, seen: Set<string>): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some((e) => reaches(e.target, to, seen));
  };
  const out = new Set<string>();
  // Edges are decided in order, so a cycle is broken once (at its first edge) and later edges stay values.
  for (const [name, list] of edges) {
    for (const edge of [...list]) {
      if (!reaches(edge.target, name, new Set())) continue;
      out.add(`${name}\0${edge.property}`);
      edges.set(name, (edges.get(name) ?? []).filter((e) => e !== edge));
    }
  }
  return out;
}

/**
 * The variants a union reads. In an untagged union, a variant that is itself an untagged union leading back to this
 * one (`U1 = U2 | string`, `U2 = U1 | int`) would make UnmarshalJSON recurse forever on the same JSON, so such a
 * variant is replaced by its own variants (recursively, skipping the cycle).
 */
export function readVariants(schemaName: string, schema: UnionSchema, resolver: { schema(name: string): IRSchema | undefined }): IRSchema[] {
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

/** A struct field (or parameter) type: nilable types as they are, pointers for optional or nullable values. */
export function fieldType(resolver: GoTypeResolver, schema: IRSchema, required: boolean, path: string[], forcePointer = false): GoType {
  const type = resolver.typeOf(schema, path);
  if (type.nilable) return type;
  return !required || resolver.isNullable(schema) || forcePointer ? resolver.pointer(type) : type;
}

type Context = { ctx: PluginContext<GoPluginOptions>; names: GoNames; resolver: GoTypeResolver; plan: ModelPlan };

/** One file per declared named schema: `<snake>_model.go`. */
export function renderModels(c: Context, packageName: string, module: string): EmittedModel[] {
  const out: EmittedModel[] = [];
  for (const [schemaName, schema] of c.ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    const typeName = c.names.types.get(schemaName) as string;
    const w = c.ctx.writer({ indent: '\t' });
    const imports: string[] = [];
    doc(w, withDeprecation(schema.description, schema.deprecated));
    if (schema.kind === 'object') renderStruct(c, w, schemaName, schema, typeName, imports);
    else if (schema.kind === 'enum') renderEnum(c, w, schema, typeName);
    else if (schema.kind === 'union') renderUnion(c, w, schemaName, schema as UnionSchema, typeName, imports);
    out.push({ path: c.names.files.get(schemaName) as string, content: goSource(c.ctx, packageName, module, w.toString(), imports) });
  }
  return out;
}

function renderStruct(c: Context, w: CodeWriter, schemaName: string, schema: ObjectSchema, typeName: string, imports: string[]): void {
  const fields = c.names.fields(schemaName);
  const rows: Row[] = [];
  const defaults: { property: string; field: string; tag: string; pointer: boolean }[] = [];
  const nonNull: string[] = [];
  const nullable: string[] = [];
  for (const p of schema.properties) {
    const path = ['schemas', schemaName, 'properties', p.name];
    const type = fieldType(c.resolver, p.schema, p.required, path, c.plan.pointerFields.has(`${schemaName}\0${p.name}`));
    imports.push(...(type.imports ?? []));
    const field = fields.get(p.name) as string;
    rows.push(...docRows(withDeprecation(p.schema.description, p.schema.deprecated)));
    let tag = `\`json:"${p.name}${p.required ? '' : ',omitempty'}"\``;
    if (!isValidTagName(p.name)) {
      c.ctx.diagnostics.warn(
        'unsupported-property-name',
        `Property "${p.name}" of "${schemaName}" cannot be a Go json tag name; the field is left out of JSON.`,
        p.schema.origin,
      );
      tag = '`json:"-"`';
    }
    rows.push([field, type.code, tag]);
    if (p.required) (c.resolver.isNullable(p.schema) ? nullable : nonNull).push(p.name);

    const discriminatorTag = c.plan.tags.get(schemaName)?.get(p.name);
    const base = type.code.replace(/^\*/, '');
    const target = p.schema.kind === 'ref' ? c.resolver.schema(p.schema.name) : undefined;
    if (discriminatorTag !== undefined && (base === 'string' || (target?.kind === 'enum' && target.base === 'string'))) {
      defaults.push({ property: p.name, field, tag: discriminatorTag, pointer: type.code.startsWith('*') });
    }
  }

  w.block(`type ${typeName} struct {`, () => writeRows(w, rows));
  // One discriminator per object: MarshalJSON can exist once.
  const d = defaults[0];
  if (d !== undefined) {
    w.blank();
    w.line(`// MarshalJSON writes the discriminator ${goString(d.property)} as ${goString(d.tag)} when it is not set.`);
    w.block(`func (v ${typeName}) MarshalJSON() ([]byte, error) {`, () => {
      w.line(`type plain ${typeName}`);
      if (d.pointer) {
        w.block(`if v.${d.field} == nil {`, () => w.line(`v.${d.field} = core.Ptr(${goString(d.tag)})`));
      } else {
        w.block(`if v.${d.field} == "" {`, () => w.line(`v.${d.field} = ${goString(d.tag)}`));
      }
      w.line('return json.Marshal(plain(v))');
    });
  }
  if (nonNull.length > 0 || nullable.length > 0) {
    const list = (names: string[]) => (names.length === 0 ? 'nil' : `[]string{${names.map(goString).join(', ')}}`);
    w.blank();
    w.line('// UnmarshalJSON reads the JSON object, failing when a required property is missing.');
    w.block(`func (v *${typeName}) UnmarshalJSON(data []byte) error {`, () => {
      w.block(`if err := core.CheckRequired(data, ${goString(typeName)}, ${list(nonNull)}, ${list(nullable)}); err != nil {`, () => w.line('return err'));
      w.line(`type plain ${typeName}`);
      w.line('return json.Unmarshal(data, (*plain)(v))');
    });
  }
}

/** A Go literal of an enum value. */
function enumLiteral(value: string | number, base: EnumSchema['base']): string {
  if (base === 'string') return goString(String(value));
  return String(value);
}

function enumConstantName(value: string | number): string {
  if (value === '') return 'Empty';
  if (typeof value === 'number') return String(value).replace('-', 'Minus').replace('.', '_').replace('+', '');
  return goIdentifier(value, 'PascalCase');
}

function renderEnum(c: Context, w: CodeWriter, schema: EnumSchema, typeName: string): void {
  const base = schema.base === 'string' ? 'string' : schema.base === 'integer' ? 'int64' : 'float64';
  const members = schema.values.map((v) => ({ name: c.names.claim(`${typeName}${enumConstantName(v)}`), value: v }));
  w.line(`type ${typeName} ${base}`);
  if (members.length > 0) {
    w.blank();
    w.line(`// Values of ${typeName} the API declares (others are kept as they are).`);
    w.block('const (', () => writeRows(w, members.map((m) => [m.name, typeName, `= ${enumLiteral(m.value, schema.base)}`])), ')');
  }
  w.blank();
  w.line('// IsKnown reports whether v is one of the values the API declares.');
  w.block(`func (v ${typeName}) IsKnown() bool {`, () => {
    if (members.length > 0) {
      w.line('switch v {');
      w.line(`case ${members.map((m) => m.name).join(', ')}:`);
      w.indent(() => w.line('return true'));
      w.line('}');
    }
    w.line('return false');
  });
}

function renderUnion(c: Context, w: CodeWriter, schemaName: string, schema: UnionSchema, typeName: string, imports: string[]): void {
  const variants = c.plan.variants.get(schemaName) ?? [];
  for (const v of variants) imports.push(...(v.type.imports ?? []));
  const rows: Row[] = variants.map((v) => [v.field, `*${v.type.code}`]);
  rows.push('// Raw is the JSON of a value no variant matched; it is written back as is.');
  rows.push(['Raw', 'json.RawMessage']);
  w.block(`type ${typeName} struct {`, () => writeRows(w, rows));

  w.blank();
  w.line('// MarshalJSON writes the variant that is set (Raw when none is).');
  w.block(`func (u ${typeName}) MarshalJSON() ([]byte, error) {`, () => {
    w.line('switch {');
    for (const v of variants) {
      w.line(`case u.${v.field} != nil:`);
      w.indent(() => w.line(`return json.Marshal(u.${v.field})`));
    }
    w.line('case u.Raw != nil:');
    w.indent(() => w.line('return u.Raw, nil'));
    w.line('}');
    w.line('return []byte("null"), nil');
  });

  w.blank();
  const discriminator = schema.discriminator;
  w.line(
    discriminator
      ? `// UnmarshalJSON picks the variant by the discriminator ${goString(discriminator.property)}; an unknown value is kept in Raw.`
      : '// UnmarshalJSON tries the variants in order; a value none of them reads is kept in Raw.',
  );
  w.block(`func (u *${typeName}) UnmarshalJSON(data []byte) error {`, () => {
    w.line(`*u = ${typeName}{}`);
    w.block('if string(data) == "null" {', () => w.line('return nil'));
    if (discriminator) {
      const cases = variants.flatMap((v) => {
        const tags = [...discriminator.mapping].filter(([, target]) => v.schema.kind === 'ref' && v.schema.name === target).map(([tag]) => tag);
        return tags.length > 0 ? [{ v, tags }] : [];
      });
      if (cases.length > 0) {
        w.line(`switch core.Discriminator(data, ${goString(discriminator.property)}) {`);
        for (const { v, tags } of cases) {
          w.line(`case ${tags.map(goString).join(', ')}:`);
          w.indent(() => w.line(`return json.Unmarshal(data, &u.${v.field})`));
        }
        w.line('}');
      }
    } else if (variants.length > 0) {
      const guarded = variants.some((v) => v.type.json !== undefined);
      if (guarded) w.line('kind := core.JSONType(data)');
      for (const v of variants) {
        const attempt = () =>
          w.block(`if v, ok := core.Try[${v.type.code}](data); ok {`, () => {
            w.line(`u.${v.field} = v`);
            w.line('return nil');
          });
        if (v.type.json !== undefined) w.block(`if kind == ${goString(v.type.json)} {`, attempt);
        else attempt();
      }
    }
    w.line('u.Raw = append(json.RawMessage(nil), data...)');
    w.line('return nil');
  });
}
