import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { doc, literal, rsWriter } from './emit.js';
import type { RustPluginOptions } from './index.js';
import { bare, rsIdentifier, sanitize, type RsNames } from './names.js';
import { isDeclared, type RsType, type RsTypeResolver } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

/** One variant of a union enum. `target` is the named schema it holds, if any. */
export type UnionVariant = { schema: IRSchema; name: string; type: RsType; target?: string; boxed: boolean };

export type EmittedModel = { path: string; content: string };

const DEPRECATED = '#[deprecated]';

/**
 * Which named types contain which others inline (not behind a `Vec` / `HashMap`), to decide where `Box` breaks a
 * cycle (a struct containing itself would have an infinite size).
 */
export class Containment {
  private readonly edges = new Map<string, Set<string>>();
  private readonly reachCache = new Map<string, Set<string>>();

  constructor(
    ir: IRDocument,
    private readonly resolver: RsTypeResolver,
  ) {
    for (const [name, schema] of ir.schemas) {
      const targets = new Set<string>();
      if (schema.kind === 'object' && isDeclared(schema)) {
        for (const p of schema.properties) for (const t of this.direct(p.schema)) targets.add(t);
      } else if (schema.kind === 'union') {
        for (const v of readVariants(name, schema, resolver)) for (const t of this.direct(v)) targets.add(t);
      }
      this.edges.set(name, targets);
    }
  }

  /** The declared schemas a usage of `schema` holds inline (a ref, possibly through non-declared aliases). */
  direct(schema: IRSchema, visiting: ReadonlySet<string> = new Set()): string[] {
    if (schema.kind !== 'ref') return [];
    const target = this.resolver.schema(schema.name);
    if (target === undefined) return [];
    if (isDeclared(target)) return [schema.name];
    if (visiting.has(schema.name)) return [];
    return this.direct(target, new Set(visiting).add(schema.name));
  }

  /** Whether `owner` holding `schema` inline closes a cycle (so the usage needs a `Box`). */
  needsBox(owner: string, schema: IRSchema): boolean {
    return this.direct(schema).some((t) => t === owner || this.reach(t).has(owner));
  }

  private reach(from: string): Set<string> {
    const cached = this.reachCache.get(from);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(this.edges.get(from) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(this.edges.get(next) ?? []));
    }
    this.reachCache.set(from, seen);
    return seen;
  }
}

/**
 * The variants a union reads. In an untagged union, a variant that is itself an untagged union leading back to this
 * one (`U1 = U2 | string`, `U2 = U1 | int`) would make deserialization recurse forever, so such a variant is replaced
 * by its own variants (recursively, skipping the cycle). Nulls and the union itself are dropped.
 */
export function readVariants(schemaName: string, schema: UnionSchema, resolver: RsTypeResolver): IRSchema[] {
  const keep = (v: IRSchema) => v.kind !== 'null' && !(v.kind === 'ref' && v.name === schemaName);
  if (schema.discriminator) return schema.variants.filter(keep);
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
  return expand(schema.variants, new Set([schemaName])).filter(keep);
}

/** Every union's variants, in reading order (duplicates of one Rust type merged). */
export function planUnions(ir: IRDocument, resolver: RsTypeResolver, containment: Containment): Map<string, UnionVariant[]> {
  const plan = new Map<string, UnionVariant[]>();
  for (const [schemaName, schema] of ir.schemas) {
    if (schema.kind !== 'union') continue;
    const namer = new UniqueNamer(['Unknown', 'Self']);
    const seen = new Set<string>();
    const list: UnionVariant[] = [];
    readVariants(schemaName, schema, resolver).forEach((variant, i) => {
      const type = resolver.typeOf(variant, ['schemas', schemaName, 'variants', String(i)], 'super::');
      if (seen.has(type.code)) return;
      seen.add(type.code);
      const target = variant.kind === 'ref' && resolver.declares(variant.name) ? variant.name : undefined;
      list.push({
        schema: variant,
        name: namer.claim(sanitize(rsIdentifier(type.friendly, 'PascalCase'))),
        type,
        ...(target !== undefined && { target }),
        boxed: containment.needsBox(schemaName, variant),
      });
    });
    plan.set(schemaName, list);
  }
  return plan;
}

/** `src/models/<module>.rs` per declared schema, and `src/models/mod.rs` re-exporting them. */
export function renderModels(
  ctx: PluginContext<RustPluginOptions>,
  names: RsNames,
  resolver: RsTypeResolver,
  containment: Containment,
  unions: Map<string, UnionVariant[]>,
): EmittedModel[] {
  const out: EmittedModel[] = [];
  const declared: string[] = [];
  const defaultable = defaultability(ctx.ir, names, resolver, containment);
  for (const [schemaName, schema] of ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    declared.push(schemaName);
    const typeName = names.types.get(schemaName) as string;
    const w = rsWriter(ctx);
    doc(w, schema.description);
    if (schema.kind === 'object') {
      renderStruct(w, { schemaName, schema, typeName, names, resolver, containment, defaultable: defaultable(schemaName) });
    } else if (schema.kind === 'enum') {
      renderEnum(w, schema, typeName);
    } else if (schema.kind === 'union') {
      renderUnion(w, schema as UnionSchema, typeName, unions.get(schemaName) ?? []);
    }
    out.push({ path: `src/models/${names.modules.get(schemaName)}.rs`, content: w.toString() });
  }

  const w = rsWriter(ctx);
  w.line('//! The schemas of the API.');
  if (declared.length > 0) w.blank();
  for (const name of declared) w.line(`mod ${names.modules.get(name)};`);
  if (declared.length > 0) w.blank();
  for (const name of declared) w.line(`pub use self::${names.modules.get(name)}::${names.types.get(name)};`);
  out.push({ path: 'src/models/mod.rs', content: w.toString() });
  return out;
}

/** Whether a struct can derive `Default`: every required, non-nullable field's type implements it. */
function defaultability(ir: IRDocument, names: RsNames, resolver: RsTypeResolver, containment: Containment): (name: string) => boolean {
  const cache = new Map<string, boolean>();
  const check = (name: string, visiting: ReadonlySet<string>): boolean => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const schema = ir.schemas.get(name);
    if (schema?.kind !== 'object' || visiting.has(name)) return false;
    const inner = new Set(visiting).add(name);
    const result = schema.properties.every((p) => {
      if (!p.required || resolver.isNullable(p.schema)) return true;
      const type = resolver.typeOf(p.schema, ['schemas', name, 'properties', p.name], 'super::');
      if (type.defaultable) return true;
      const [target] = containment.direct(p.schema);
      return (
        target !== undefined &&
        type.code === `super::${names.types.get(target)}` &&
        !containment.needsBox(name, p.schema) &&
        check(target, inner)
      );
    });
    if (visiting.size === 0) cache.set(name, result);
    return result;
  };
  return (name) => check(name, new Set());
}

function renderStruct(
  w: CodeWriter,
  c: {
    schemaName: string;
    schema: ObjectSchema;
    typeName: string;
    names: RsNames;
    resolver: RsTypeResolver;
    containment: Containment;
    defaultable: boolean;
  },
): void {
  const members = c.names.members(c.schemaName);
  const derives = ['Debug', 'Clone', 'PartialEq', ...(c.defaultable ? ['Default'] : []), 'serde::Serialize', 'serde::Deserialize'];
  w.line(`#[derive(${derives.join(', ')})]`);
  if (c.schema.deprecated) w.line(DEPRECATED);
  w.block(`pub struct ${c.typeName} {`, () => {
    for (const p of c.schema.properties) {
      const field = members.get(p.name) as string;
      let type = c.resolver.typeOf(p.schema, ['schemas', c.schemaName, 'properties', p.name], 'super::').code;
      if (c.containment.needsBox(c.schemaName, p.schema)) type = `Box<${type}>`;
      const optional = !p.required || c.resolver.isNullable(p.schema);
      if (optional) type = `Option<${type}>`;
      const serde: string[] = [];
      // serde names a raw identifier's field without its `r#`.
      if (bare(field) !== p.name) serde.push(`rename = ${literal(p.name)}`);
      if (!p.required) serde.push('default', 'skip_serializing_if = "Option::is_none"');
      doc(w, p.schema.description);
      if (p.schema.deprecated) w.line(DEPRECATED);
      if (serde.length > 0) w.line(`#[serde(${serde.join(', ')})]`);
      w.line(`pub ${field}: ${type},`);
    }
  });
}

/** Variant names for enum values: the value in PascalCase (`Value1` for numbers, `Empty` for `""`). */
function enumMembers(schema: EnumSchema): { name: string; value: string | number }[] {
  const namer = new UniqueNamer(['Unknown', 'Self']);
  return schema.values.map((value) => {
    let base: string;
    if (value === '') base = 'Empty';
    else if (typeof value === 'number') base = `${value < 0 ? 'Minus' : 'Value'}${rsIdentifier(String(Math.abs(value)), 'PascalCase').replace(/^_/, '')}`;
    else base = rsIdentifier(value, 'PascalCase');
    if (/^[0-9_]/.test(base)) base = `Value${base.replace(/^_/, '')}`;
    return { name: namer.claim(base), value };
  });
}

function numberLiteral(value: number, float: boolean): string {
  const text = String(value);
  return float && !/[.eE]/.test(text) ? `${text}.0` : text;
}

function renderEnum(w: CodeWriter, schema: EnumSchema, typeName: string): void {
  const members = enumMembers(schema);
  const base = schema.base;
  const raw = base === 'string' ? 'String' : base === 'integer' ? 'i64' : 'f64';
  const lit = (v: string | number) => (base === 'string' ? literal(String(v)) : numberLiteral(Number(v), base === 'number'));
  const comparable = base !== 'number';

  w.line(comparable ? '#[derive(Debug, Clone)]' : '#[derive(Debug, Clone, Copy)]');
  if (schema.deprecated) w.line(DEPRECATED);
  w.block(`pub enum ${typeName} {`, () => {
    for (const m of members) w.line(`${m.name},`);
    w.line('/// A value the API did not declare.');
    w.line(`Unknown(${raw}),`);
  });
  w.blank();
  w.block(`impl ${typeName} {`, () => {
    w.line('/// The values the API declared.');
    w.line(`pub const KNOWN_VALUES: &'static [${typeName}] = &[${members.map((m) => `${typeName}::${m.name}`).join(', ')}];`);
    w.blank();
    if (base === 'string') {
      w.line('/// The raw value.');
      w.block('pub fn as_str(&self) -> &str {', () => {
        w.block('match self {', () => {
          for (const m of members) w.line(`Self::${m.name} => ${lit(m.value)},`);
          w.line('Self::Unknown(value) => value,');
        });
      });
    } else {
      w.line('/// The raw value.');
      w.block(`pub fn value(&self) -> ${raw} {`, () => {
        w.block('match self {', () => {
          for (const m of members) w.line(`Self::${m.name} => ${lit(m.value)},`);
          w.line('Self::Unknown(value) => *value,');
        });
      });
    }
    w.blank();
    w.line('/// Whether the value is one the API declared.');
    w.block('pub fn is_known(&self) -> bool {', () => {
      w.line('!matches!(self, Self::Unknown(_))');
    });
  });
  w.blank();

  const from = (param: string, arg: string) => {
    w.block(`impl From<${param}> for ${typeName} {`, () => {
      w.block(`fn from(value: ${param}) -> Self {`, () => {
        if (members.length === 0) {
          w.line(`Self::Unknown(${arg})`);
        } else if (base === 'number') {
          members.forEach((m, i) => {
            w.line(`${i === 0 ? 'if' : '} else if'} value == ${lit(m.value)} {`);
            w.indent(() => w.line(`Self::${m.name}`));
          });
          w.line('} else {');
          w.indent(() => w.line(`Self::Unknown(${arg})`));
          w.line('}');
        } else {
          w.block('match value {', () => {
            for (const m of members) w.line(`${lit(m.value)} => Self::${m.name},`);
            w.line(`_ => Self::Unknown(${arg}),`);
          });
        }
      });
    });
  };
  if (base === 'string') {
    from('&str', 'value.to_owned()');
    w.blank();
    w.block(`impl From<String> for ${typeName} {`, () => {
      w.block('fn from(value: String) -> Self {', () => w.line('Self::from(value.as_str())'));
    });
  } else {
    from(raw, 'value');
  }
  w.blank();

  const key = base === 'string' ? 'self.as_str()' : 'self.value()';
  w.block(`impl PartialEq for ${typeName} {`, () => {
    w.block('fn eq(&self, other: &Self) -> bool {', () => w.line(`${key} == ${key.replace('self', 'other')}`));
  });
  if (comparable) {
    w.blank();
    w.line(`impl Eq for ${typeName} {}`);
    w.blank();
    w.block(`impl std::hash::Hash for ${typeName} {`, () => {
      w.block('fn hash<H: std::hash::Hasher>(&self, state: &mut H) {', () => w.line(`${key}.hash(state);`));
    });
  }
  w.blank();
  w.block(`impl std::fmt::Display for ${typeName} {`, () => {
    w.block("fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {", () => {
      w.line(base === 'string' ? 'f.write_str(self.as_str())' : 'write!(f, "{}", self.value())');
    });
  });
  w.blank();
  w.block(`impl serde::Serialize for ${typeName} {`, () => {
    w.block('fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {', () => {
      w.line(base === 'string' ? 'serializer.serialize_str(self.as_str())' : `serializer.serialize_${raw}(self.value())`);
    });
  });
  w.blank();
  w.block(`impl<'de> serde::Deserialize<'de> for ${typeName} {`, () => {
    w.block("fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {", () => {
      w.line(`Ok(Self::from(<${raw} as serde::Deserialize>::deserialize(deserializer)?))`);
    });
  });
}

function variantType(v: UnionVariant): string {
  return v.boxed ? `Box<${v.type.code}>` : v.type.code;
}

function renderUnion(w: CodeWriter, schema: UnionSchema, typeName: string, variants: UnionVariant[]): void {
  const discriminator = schema.discriminator;
  if (discriminator) {
    w.line('#[derive(Debug, Clone, PartialEq)]');
  } else {
    w.line('#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]');
    w.line('#[serde(untagged)]');
  }
  if (schema.deprecated) w.line(DEPRECATED);
  w.block(`pub enum ${typeName} {`, () => {
    for (const v of variants) w.line(`${v.name}(${variantType(v)}),`);
    w.line('/// A value no variant matched, kept as raw JSON.');
    w.line('Unknown(serde_json::Value),');
  });

  for (const v of variants) {
    if (v.type.code === 'serde_json::Value') continue; // `Unknown` holds the same type
    w.blank();
    w.block(`impl From<${v.type.code}> for ${typeName} {`, () => {
      w.block(`fn from(value: ${v.type.code}) -> Self {`, () => w.line(`Self::${v.name}(${v.boxed ? 'Box::new(value)' : 'value'})`));
    });
  }

  if (!discriminator) return;
  w.blank();
  w.block(`impl serde::Serialize for ${typeName} {`, () => {
    w.block('fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {', () => {
      w.block('match self {', () => {
        for (const v of variants) w.line(`Self::${v.name}(value) => serde::Serialize::serialize(value, serializer),`);
        w.line('Self::Unknown(value) => serde::Serialize::serialize(value, serializer),');
      });
    });
  });
  w.blank();
  const branches = [...discriminator.mapping].flatMap(([tag, target]) => {
    const v = variants.find((x) => x.target === target);
    return v ? [{ tag, v }] : [];
  });
  w.block(`impl<'de> serde::Deserialize<'de> for ${typeName} {`, () => {
    w.block("fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {", () => {
      w.line('let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;');
      if (branches.length === 0) {
        w.line('Ok(Self::Unknown(value))');
        return;
      }
      w.line(`let tag = value.get(${literal(discriminator.property)}).and_then(serde_json::Value::as_str).map(str::to_owned);`);
      w.block('match tag.as_deref() {', () => {
        for (const { tag, v } of branches) {
          w.line(`Some(${literal(tag)}) => serde_json::from_value(value).map(Self::${v.name}).map_err(serde::de::Error::custom),`);
        }
        w.line('_ => Ok(Self::Unknown(value)),');
      });
    });
  });
}
