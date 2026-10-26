import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { readVariants } from '../go/models.js';
import { doc, rbFile, rbString, rbSymbol, writeList } from './emit.js';
import type { RubyPluginOptions } from './index.js';
import { screaming, type RubyNames } from './names.js';
import { isDeclared, optional, type RubyType, type RubyTypeResolver } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

export const DEPRECATED = '@deprecated Deprecated in the API.';

/** A doc text followed by the deprecation tag when `deprecated`. */
export function withDeprecation(text: string | undefined, deprecated: boolean | undefined): string | undefined {
  if (!deprecated) return text;
  return text === undefined || text.trim() === '' ? DEPRECATED : `${text}\n\n${DEPRECATED}`;
}

/** A member / parameter description followed by a deprecation note when `deprecated`. */
export function withDeprecationNote(text: string | undefined, deprecated: boolean | undefined): string | undefined {
  if (!deprecated) return text;
  return text === undefined || text.trim() === '' ? 'Deprecated in the API.' : `${text.trimEnd()} (deprecated in the API)`;
}

/** One member of a model. */
export type Member = { wire: string; name: string; type: RubyType; required: boolean; nullable: boolean; tag?: string; description?: string; deprecated?: boolean };

export type ModelPlan = {
  /** Union schema → its variant types, in reading order (duplicates merged). */
  variants: Map<string, RubyType[]>;
  /** Object schema → discriminator property (wire name) → the one tag its unions map it to (the member's default). */
  tags: Map<string, Map<string, string>>;
};

/** Decides every union's variants and the tags objects default to. */
export function planModels(ir: IRDocument, resolver: RubyTypeResolver): ModelPlan {
  const variants = new Map<string, RubyType[]>();
  const tagSets = new Map<string, Map<string, Set<string>>>();
  for (const [schemaName, schema] of ir.schemas) {
    if (schema.kind !== 'union') continue;
    const seen = new Set<string>();
    const list: RubyType[] = [];
    readVariants(schemaName, schema, resolver).forEach((variant, i) => {
      if (variant.kind === 'null' || (variant.kind === 'ref' && variant.name === schemaName)) return;
      const type = resolver.typeOf(variant, ['schemas', schemaName, 'variants', String(i)]);
      if (seen.has(type.expr)) return;
      seen.add(type.expr);
      list.push(type);
    });
    variants.set(schemaName, list);

    const discriminator = schema.discriminator;
    if (!discriminator) continue;
    for (const [tag, target] of discriminator.mapping) {
      if (!schema.variants.some((v) => v.kind === 'ref' && v.name === target && resolver.objectTarget(v) === target)) continue;
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
  return { variants, tags };
}

type Context = { ctx: PluginContext<RubyPluginOptions>; names: RubyNames; resolver: RubyTypeResolver; plan: ModelPlan; moduleName: string };

/** The members of an object model, in property order. */
export function members(c: Pick<Context, 'names' | 'resolver' | 'plan'>, schemaName: string, schema: ObjectSchema): Member[] {
  const names = c.names.members(schemaName);
  return schema.properties.map((p) => {
    const type = c.resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name]);
    const isNullable = c.resolver.isNullable(p.schema);
    const target = p.schema.kind === 'ref' ? c.resolver.schema(p.schema.name) : undefined;
    const tag = c.plan.tags.get(schemaName)?.get(p.name);
    const stringy = type.expr === 'Core::Types::STRING';
    return {
      wire: p.name,
      name: names.get(p.name) as string,
      type,
      required: p.required,
      nullable: isNullable,
      ...(tag !== undefined && (stringy || (target?.kind === 'enum' && target.base === 'string')) ? { tag } : {}),
      ...(p.schema.description !== undefined ? { description: p.schema.description } : {}),
      ...(p.schema.deprecated ? { deprecated: true } : {}),
    };
  });
}

/** The RBS / YARD type of a member as stored (nil allowed when optional or nullable). */
export function memberType(m: Member): { rbs: string; doc: string } {
  return !m.required || m.nullable ? { rbs: optional(m.type.rbs), doc: `${m.type.doc}, nil` } : { rbs: m.type.rbs, doc: m.type.doc };
}

/** One file per declared named schema: `models/<snake>.rb`. */
export function renderModels(c: Context): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const [schemaName, schema] of c.ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    const typeName = c.names.types.get(schemaName) as string;
    const content = rbFile(c.ctx, c.moduleName, (w) => {
      const text = withDeprecation(schema.description, schema.deprecated);
      if (schema.kind === 'object') renderObject(c, w, schemaName, schema, typeName, text);
      else if (schema.kind === 'enum') renderEnum(w, schema, typeName, text);
      else if (schema.kind === 'union') renderUnion(c, w, schemaName, schema as UnionSchema, typeName, text);
    });
    out.push({ path: c.names.files.get(schemaName) as string, content });
  }
  return out;
}

function renderObject(c: Context, w: CodeWriter, schemaName: string, schema: ObjectSchema, typeName: string, text: string | undefined): void {
  const list = members(c, schemaName, schema);
  doc(w, text);
  w.line(`${typeName} = ::Data.define(${list.map((m) => rbSymbol(m.name)).join(', ')})`);
  w.blank();
  w.block(`class ${typeName}`, () => {
    w.line('include Core::Model');
    w.blank();
    for (const m of list) {
      const type = memberType(m);
      const description = withDeprecationNote(m.description, m.deprecated);
      const lines = description === undefined ? [] : description.split('\n');
      w.line(`# @param ${m.name} [${type.doc}]${lines[0] ? ` ${lines[0].trimEnd()}` : ''}`);
      for (const line of lines.slice(1)) w.line(line.trim() === '' ? '#' : `#   ${line.trimEnd()}`);
    }
    const args = list.map((m) => {
      if (m.tag !== undefined) return `${m.name}: ${rbString(m.tag)}`;
      return m.required ? `${m.name}:` : `${m.name}: nil`;
    });
    w.block(`def initialize(${args.join(', ')})`, () => w.line('super'), 'end');
    w.blank();
    writeList(
      w,
      'json_fields(',
      list.map((m) => {
        const flags = [m.required ? 'required: true' : undefined, m.nullable ? 'nullable: true' : undefined].filter(Boolean);
        return `Core::Field.new(name: ${rbSymbol(m.name)}, wire: ${rbString(m.wire)}, type: ${m.type.expr}${flags.map((f) => `, ${f}`).join('')})`;
      }),
    );
  }, 'end');
}

/** The constant name of an enum value. */
export function enumConstant(value: string | number): string {
  if (value === '') return 'EMPTY';
  if (typeof value === 'number') return `V_${String(value).replace(/^-/, 'MINUS_').replace(/[.+]/g, '_').toUpperCase()}`;
  return screaming(value);
}

/** A Ruby literal of an enum value. */
function enumLiteral(value: string | number): string {
  return typeof value === 'string' ? rbString(value) : String(value);
}

function renderEnum(w: CodeWriter, schema: EnumSchema, typeName: string, text: string | undefined): void {
  const namer = new UniqueNamer(['VALUES']);
  const values = schema.values.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  const constants = values.map((v) => ({ name: namer.claim(enumConstant(v)), value: v }));
  doc(w, text);
  w.block(`module ${typeName}`, () => {
    for (const k of constants) w.line(`${k.name} = ${enumLiteral(k.value)}`);
    if (constants.length > 0) w.blank();
    w.line('# Every value the API declares (other values are kept as they are).');
    w.line(constants.length === 0 ? 'VALUES = [].freeze' : `VALUES = [${constants.map((k) => k.name).join(', ')}].freeze`);
    w.blank();
    w.line('# Whether `value` is one the API declares.');
    w.line('def self.known?(value) = VALUES.include?(value)');
  }, 'end');
}

function renderUnion(c: Context, w: CodeWriter, schemaName: string, schema: UnionSchema, typeName: string, text: string | undefined): void {
  const variants = c.plan.variants.get(schemaName) ?? [];
  const discriminator = schema.discriminator;
  doc(w, text);
  w.block(`module ${typeName}`, () => {
    w.line('extend Core::Union');
    w.blank();
    if (discriminator) {
      w.line(`# Picks the variant by the discriminator ${rbString(discriminator.property)}; an unknown value is kept as Core::Unknown.`);
      const entries = [...discriminator.mapping].flatMap(([tag, target]) => {
        const name = c.names.types.get(target);
        return name !== undefined && isDeclared(c.resolver.schema(target) as IRSchema) ? [`${rbString(tag)} => Core::Types.ref(-> { ${name} })`] : [];
      });
      writeList(w, `discriminator ${rbString(discriminator.property)}, {`, entries, '}');
    } else {
      w.line('# Tries the variants in order; a value none of them reads is kept as Core::Unknown.');
      if (variants.length === 0) w.line('variants');
      else writeList(w, 'variants(', variants.map((v) => v.expr));
    }
  }, 'end');
}

/** The RBS type of a union's values. */
export function unionRbs(variants: RubyType[]): string {
  return [...new Set([...variants.map((v) => v.rbs), 'Core::Unknown'])].join(' | ');
}

