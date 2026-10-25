import type { IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { block, doc, literal, swiftFile, switchBlock } from './emit.js';
import type { SwiftPluginOptions } from './index.js';
import { escape, fileBaseName, sanitize, swIdentifier, type SwNames } from './names.js';
import { RESERVED_CASES } from './reserved.js';
import { isDeclared, optional, type SwType, type SwTypeResolver } from './types.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type EnumSchema = Extract<IRSchema, { kind: 'enum' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

export type ModelContext = {
  ctx: PluginContext<SwiftPluginOptions>;
  names: SwNames;
  resolver: SwTypeResolver;
  /** `<schema>\0<property>` keys of properties stored in `Indirect`. */
  boxed: Set<string>;
  /** Imports of every SDK file. */
  imports: string[];
  /** Directory of the SDK module's sources (`Sources/<Module>`). */
  dir: string;
};

/** One file per declared named schema: `Sources/<Module>/Models/<Type>.swift`. */
export function renderModels(m: ModelContext): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const [schemaName, schema] of m.ctx.ir.schemas) {
    if (!isDeclared(schema)) continue;
    const typeName = m.names.types.get(schemaName) as string;
    const w = swiftFile(m.ctx, m.imports);
    doc(w, schema.description);
    if (schema.deprecated) {
      if (schema.description) w.line('///');
      w.line('/// - Note: Deprecated.');
    }
    if (schema.kind === 'object') renderStruct(w, m, schemaName, schema, typeName);
    else if (schema.kind === 'enum') renderEnum(w, m, schema, typeName);
    else if (schema.kind === 'union') renderUnion(w, m, schemaName, schema as UnionSchema, typeName);
    out.push({ path: `${m.dir}/Models/${fileBaseName(typeName, m.ctx.options)}.swift`, content: w.toString() });
  }
  return out;
}

/** The case names of an enum schema, by value. */
export function enumCases(schema: EnumSchema): { name: string; value: string | number }[] {
  const namer = new UniqueNamer(RESERVED_CASES);
  return schema.values.map((value) => {
    const base = value === '' ? 'empty' : swIdentifier(String(value), 'camelCase');
    return { name: namer.claim(base), value };
  });
}

function enumLiteral(schema: EnumSchema, value: string | number): string {
  return schema.base === 'string' ? literal(String(value)) : String(value);
}

type Property = {
  wire: string;
  /** Unescaped Swift name. */
  name: string;
  type: SwType;
  code: string;
  required: boolean;
  nullable: boolean;
  boxed: boolean;
  defaultValue?: string;
  schema: IRSchema;
};

/** The default argument of a required property whose value is fixed (a const or single-value enum). */
function fixedDefault(schema: IRSchema, type: SwType, m: ModelContext): string | undefined {
  if (schema.kind === 'const') {
    if (typeof schema.value === 'string' && type.code === m.names.std('String')) return literal(schema.value);
    if (typeof schema.value === 'boolean' && type.code === m.names.std('Bool')) return String(schema.value);
    if (typeof schema.value === 'number' && (type.code === m.names.std('Int') || type.code === m.names.std('Double'))) return String(schema.value);
    return undefined;
  }
  if (schema.kind !== 'ref' || type.declared !== schema.name) return undefined;
  const target = m.resolver.schema(schema.name);
  if (target?.kind !== 'enum' || target.values.length !== 1) return undefined;
  return `.${escape((enumCases(target)[0] as { name: string }).name)}`;
}

function properties(m: ModelContext, schemaName: string, schema: ObjectSchema): Property[] {
  const members = m.names.members(schemaName);
  return schema.properties.map((p) => {
    const type = m.resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name]);
    const nullable = !p.required || m.resolver.isNullable(p.schema);
    const defaultValue = !p.required ? 'nil' : nullable ? undefined : fixedDefault(p.schema, type, m);
    return {
      wire: p.name,
      name: members.get(p.name) as string,
      type,
      code: optional(type.code, nullable),
      required: p.required,
      nullable,
      boxed: m.boxed.has(`${schemaName}\0${p.name}`),
      ...(defaultValue !== undefined && { defaultValue }),
      schema: p.schema,
    };
  });
}

function renderStruct(w: CodeWriter, m: ModelContext, schemaName: string, schema: ObjectSchema, typeName: string): void {
  const { std } = m.names;
  const props = properties(m, schemaName, schema);
  const extra = schema.additionalProperties !== undefined && schema.additionalProperties !== false;
  const extraType = `[${std('String')}: JSONValue]`;
  block(w, `public struct ${typeName}: ${std('Codable')}, ${std('Hashable')}, Sendable`, () => {
    for (const p of props) {
      doc(w, p.schema.description);
      if (p.schema.deprecated) w.line('/// - Note: Deprecated.');
      if (p.boxed) {
        block(w, `public var ${escape(p.name)}: ${p.code}`, () => {
          w.line(`get { _${p.name}.value }`);
          w.line(`set { _${p.name} = Indirect(newValue) }`);
        });
        w.blank();
      } else {
        w.line(`public var ${escape(p.name)}: ${p.code}`);
      }
    }
    if (extra) {
      w.line('/// Properties not declared by the schema, as raw JSON.');
      w.line(`public var additionalProperties: ${extraType}`);
    }
    const storage = props.filter((p) => p.boxed);
    if (storage.length > 0) {
      w.blank();
      for (const p of storage) w.line(`private var _${p.name}: Indirect<${p.code}>`);
    }

    w.blank();
    const args = props.map((p) => `${escape(p.name)}: ${p.code}${p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ''}`);
    if (extra) args.push(`additionalProperties: ${extraType} = [:]`);
    block(w, `public init(${args.join(', ')})`, () => {
      for (const p of props) w.line(p.boxed ? `self._${p.name} = Indirect(${escape(p.name)})` : `self.${escape(p.name)} = ${escape(p.name)}`);
      if (extra) w.line('self.additionalProperties = additionalProperties');
    });

    w.blank();
    block(w, `private enum CodingKeys: ${std('String')}, ${std('CodingKey')}`, () => {
      for (const p of props) w.line(`case ${escape(p.name)}${p.name === p.wire ? '' : ` = ${literal(p.wire)}`}`);
    });

    w.blank();
    block(w, `public init(from decoder: any ${std('Decoder')}) throws`, () => {
      w.line('let container = try decoder.container(keyedBy: CodingKeys.self)');
      for (const p of props) {
        const method = p.required && !p.nullable ? 'decode' : 'decodeIfPresent';
        const value = `try container.${method}(${p.type.code}.self, forKey: .${escape(p.name)})`;
        w.line(p.boxed ? `self._${p.name} = Indirect(${value})` : `self.${escape(p.name)} = ${value}`);
      }
      if (extra) {
        w.line('let extra = try decoder.container(keyedBy: DynamicCodingKey.self)');
        w.line(`var additionalProperties: ${extraType} = [:]`);
        block(w, 'for key in extra.allKeys where CodingKeys(rawValue: key.stringValue) == nil', () => {
          w.line('additionalProperties[key.stringValue] = try extra.decode(JSONValue.self, forKey: key)');
        });
        w.line('self.additionalProperties = additionalProperties');
      }
    });

    w.blank();
    block(w, `public func encode(to encoder: any ${std('Encoder')}) throws`, () => {
      w.line('var container = encoder.container(keyedBy: CodingKeys.self)');
      for (const p of props) w.line(`try container.${p.required ? 'encode' : 'encodeIfPresent'}(${escape(p.name)}, forKey: .${escape(p.name)})`);
      if (extra) {
        w.line('var extra = encoder.container(keyedBy: DynamicCodingKey.self)');
        block(w, 'for (key, value) in additionalProperties.sorted(by: { $0.key < $1.key }) where CodingKeys(rawValue: key) == nil', () => {
          w.line('try extra.encode(value, forKey: DynamicCodingKey(key))');
        });
      }
    });
  });
}

function renderEnum(w: CodeWriter, m: ModelContext, schema: EnumSchema, typeName: string): void {
  const { std } = m.names;
  const raw = std(schema.base === 'string' ? 'String' : schema.base === 'integer' ? 'Int' : 'Double');
  const cases = enumCases(schema);
  block(w, `public enum ${typeName}: ${std('Codable')}, ${std('Hashable')}, Sendable, ${std('RawRepresentable')}, ${std('CaseIterable')}`, () => {
    for (const c of cases) w.line(`case ${escape(c.name)}`);
    w.line('/// A value this version of the SDK does not know.');
    w.line(`case unknown(${raw})`);
    w.blank();
    block(w, `public init(rawValue: ${raw})`, () => {
      switchBlock(w, 'switch rawValue', () => {
        for (const c of cases) w.line(`case ${enumLiteral(schema, c.value)}: self = .${escape(c.name)}`);
        w.line('default: self = .unknown(rawValue)');
      });
    });
    w.blank();
    block(w, `public var rawValue: ${raw}`, () => {
      switchBlock(w, 'switch self', () => {
        for (const c of cases) w.line(`case .${escape(c.name)}: return ${enumLiteral(schema, c.value)}`);
        w.line('case .unknown(let value): return value');
      });
    });
    w.blank();
    w.line('/// The values the API declares.');
    w.line(`public static var allCases: [${typeName}] { [${cases.map((c) => `.${escape(c.name)}`).join(', ')}] }`);
    w.blank();
    w.line('/// Whether the value is one the API declares.');
    w.line(`public var isKnown: ${std('Bool')} { ${typeName}.allCases.contains(self) }`);
    w.blank();
    block(w, `public init(from decoder: any ${std('Decoder')}) throws`, () => {
      w.line(`self.init(rawValue: try decoder.singleValueContainer().decode(${raw}.self))`);
    });
    w.blank();
    block(w, `public func encode(to encoder: any ${std('Encoder')}) throws`, () => {
      w.line('var container = encoder.singleValueContainer()');
      w.line('try container.encode(rawValue)');
    });
    w.blank();
    w.line(`public static func == (lhs: ${typeName}, rhs: ${typeName}) -> ${std('Bool')} { lhs.rawValue == rhs.rawValue }`);
    w.blank();
    w.line(`public func hash(into hasher: inout ${std('Hasher')}) { hasher.combine(rawValue) }`);
  });
}

/**
 * The variants a union enum tries. In an untagged union, a variant that is itself an untagged union leading back to
 * this one (`U1 = U2 | string`, `U2 = U1 | int`) would make the decoders call each other on the same JSON forever, so
 * such a variant is replaced by its own variants (recursively, skipping the cycle).
 */
function unionVariants(schemaName: string, schema: UnionSchema, resolver: SwTypeResolver): IRSchema[] {
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

function renderUnion(w: CodeWriter, m: ModelContext, schemaName: string, schema: UnionSchema, typeName: string): void {
  const { std } = m.names;
  const caseNames = new UniqueNamer(RESERVED_CASES);
  const seen = new Set<string>();
  const variants: { type: SwType; name: string }[] = [];
  unionVariants(schemaName, schema, m.resolver).forEach((variant, i) => {
    const type = m.resolver.typeOf({ ...variant, nullable: false }, ['schemas', schemaName, 'variants', String(i)]);
    if (type.code === typeName || seen.has(type.code)) return;
    seen.add(type.code);
    const base = sanitize(type.friendly.charAt(0).toLowerCase() + type.friendly.slice(1));
    variants.push({ type, name: caseNames.claim(base) });
  });

  block(w, `public indirect enum ${typeName}: ${std('Codable')}, ${std('Hashable')}, Sendable`, () => {
    for (const v of variants) w.line(`case ${escape(v.name)}(${v.type.code})`);
    w.line('/// A value that matched no variant, kept as raw JSON.');
    w.line('case unknown(JSONValue)');
    w.blank();
    block(w, `public init(from decoder: any ${std('Decoder')}) throws`, () => {
      const discriminator = schema.discriminator;
      if (discriminator) {
        w.line('let raw = try JSONValue(from: decoder)');
        switchBlock(w, `switch raw[${literal(discriminator.property)}]?.stringValue`, () => {
          for (const [tag, target] of discriminator.mapping) {
            const v = variants.find((x) => x.type.declared === target);
            if (v === undefined) continue;
            w.line(`case ${literal(tag)}: self = .${escape(v.name)}(try decoder.singleValueContainer().decode(${v.type.code}.self))`);
          }
          w.line('default: self = .unknown(raw)');
        });
      } else {
        for (const v of variants) {
          block(w, `if let value = try? decoder.singleValueContainer().decode(${v.type.code}.self)`, () => {
            w.line(`self = .${escape(v.name)}(value)`);
            w.line('return');
          });
        }
        w.line('self = .unknown(try JSONValue(from: decoder))');
      }
    });
    w.blank();
    block(w, `public func encode(to encoder: any ${std('Encoder')}) throws`, () => {
      w.line('var container = encoder.singleValueContainer()');
      switchBlock(w, 'switch self', () => {
        for (const v of variants) w.line(`case .${escape(v.name)}(let value): try container.encode(value)`);
        w.line('case .unknown(let value): try container.encode(value)');
      });
    });
  });
}
