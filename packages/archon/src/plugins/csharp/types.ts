import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { UniqueNamer } from '../../writer/naming.js';
import type { CSharpPluginOptions } from './index.js';
import { resolveNamespace, sanitize, type CsNames } from './names.js';
import { JSON_CONTEXT_MEMBERS } from './reserved.js';

/** A C# type expression. `info` is the base of its JSON context property name. */
export type CsType = { code: string; valueType: boolean; info: string; friendly: string };

const G = 'global::System';
const prim = (code: string, valueType: boolean, info: string, friendly = info): CsType => ({ code, valueType, info, friendly });

const STRING = prim('string', false, 'String');
const JSON_ELEMENT = prim(`${G}.Text.Json.JsonElement`, true, 'JsonElement', 'Json');

const KEYWORD_TYPES: Record<string, CsType> = {
  string: STRING,
  int: prim('int', true, 'Int32', 'Int'),
  long: prim('long', true, 'Int64', 'Long'),
  short: prim('short', true, 'Int16', 'Short'),
  byte: prim('byte', true, 'Byte'),
  double: prim('double', true, 'Double'),
  float: prim('float', true, 'Single', 'Float'),
  decimal: prim('decimal', true, 'Decimal'),
  bool: prim('bool', true, 'Boolean', 'Bool'),
  object: prim('object', false, 'Object'),
  'byte[]': prim('byte[]', false, 'ByteArray', 'Bytes'),
};

const SYSTEM_VALUE_TYPES = new Set(['Guid', 'DateTimeOffset', 'DateTime', 'DateOnly', 'TimeOnly', 'TimeSpan', 'Text.Json.JsonElement', 'Int128', 'Half']);

/** Maps IR schemas to C# types and collects the types the JSON context must register. */
export class CsTypeResolver {
  readonly namespace: string;
  private readonly registry = new Map<string, string>();
  private readonly entries: { code: string; property: string }[] = [];
  private readonly propertyNamer = new UniqueNamer(JSON_CONTEXT_MEMBERS);

  constructor(
    private readonly ir: IRDocument,
    private readonly names: CsNames,
    private readonly opts: CSharpPluginOptions,
    private readonly diagnostics: Diagnostics,
  ) {
    this.namespace = resolveNamespace(ir, opts);
  }

  /** Whether a named schema becomes its own C# type (object with properties, enum, union). */
  declares(schemaName: string): boolean {
    const schema = this.ir.schemas.get(schemaName);
    return schema !== undefined && isDeclared(schema);
  }

  /** The runtime namespace, fully qualified. */
  get core(): string {
    return `global::${this.namespace}.Core`;
  }

  /**
   * The C# type of `schema`, without nullability (see `nullableCode`). `usage: 'parameter'` turns a top-level
   * array into `IReadOnlyList<T>`. Priority: `hooks.typeOverride` → `typeMappings['kind:format']` → `typeMappings['kind']`.
   */
  typeOf(schema: IRSchema, path: SchemaPath, usage: 'model' | 'parameter', visiting: ReadonlySet<string> = new Set()): CsType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    switch (schema.kind) {
      case 'string':
        switch (schema.format) {
          case 'date-time':
            return prim(`${G}.DateTimeOffset`, true, 'DateTimeOffset');
          case 'date':
            return prim(`${G}.DateOnly`, true, 'DateOnly');
          case 'time':
            return prim(`${G}.TimeOnly`, true, 'TimeOnly');
          case 'uuid':
            return prim(`${G}.Guid`, true, 'Guid');
          case 'byte':
            return KEYWORD_TYPES['byte[]'] as CsType;
          default:
            return STRING;
        }
      case 'integer':
        return KEYWORD_TYPES[schema.format === 'int64' ? 'long' : 'int'] as CsType;
      case 'number':
        return KEYWORD_TYPES[schema.format === 'float' ? 'float' : 'double'] as CsType;
      case 'boolean':
        return KEYWORD_TYPES['bool'] as CsType;
      case 'binary':
        return prim(`${this.core}.ApiFile`, false, 'ApiFile');
      case 'const':
        return constType(schema.value);
      case 'enum':
        // Inline enums are hoisted; one left inline (a dropped discriminator) maps to its base type.
        return KEYWORD_TYPES[schema.base === 'string' ? 'string' : schema.base === 'integer' ? 'long' : 'double'] as CsType;
      case 'array': {
        const items = this.typeOf(schema.items, [...path, 'items'], 'model', visiting);
        const generic = usage === 'parameter' ? 'IReadOnlyList' : 'List';
        return { code: `${G}.Collections.Generic.${generic}<${items.code}>`, valueType: false, info: `${generic}Of${items.info}`, friendly: `${items.friendly}List` };
      }
      case 'object': {
        if (schema.properties.length > 0) return JSON_ELEMENT; // inline objects are hoisted
        const value = schema.additionalProperties ? this.typeOf(schema.additionalProperties, [...path, 'additionalProperties'], 'model', visiting) : JSON_ELEMENT;
        return { code: `${G}.Collections.Generic.Dictionary<string, ${value.code}>`, valueType: false, info: `DictionaryOfString${value.info}`, friendly: `${value.friendly}Map` };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to JsonElement.`, schema.origin);
          return JSON_ELEMENT;
        }
        if (isDeclared(target)) return { code: name, valueType: target.kind === 'enum', info: name.replace(/^@/, ''), friendly: name.replace(/^@/, '') };
        if (visiting.has(schema.name)) return JSON_ELEMENT;
        return this.typeOf(target, path, usage, new Set(visiting).add(schema.name));
      }
      default:
        // null, unknown, tuple, unflattened intersection, inline union
        return JSON_ELEMENT;
    }
  }

  /** Whether a usage is nullable: the schema itself, or the named schema it refers to. */
  isNullable(schema: IRSchema): boolean {
    if (schema.nullable) return true;
    return schema.kind === 'ref' && this.ir.schemas.get(schema.name)?.nullable === true;
  }

  nullableCode(type: CsType, nullable: boolean): string {
    return nullable ? `${type.code}?` : type.code;
  }

  /** Registers a type with the JSON context and returns its `TypeInfoPropertyName` (`ApiJsonContext.Default.<name>`). */
  register(type: CsType, nullable = false): string {
    const valueNullable = nullable && type.valueType;
    const key = valueNullable ? `${type.code}?` : type.code;
    const existing = this.registry.get(key);
    if (existing !== undefined) return existing;
    const property = this.propertyNamer.claim(valueNullable ? `Nullable${type.info}` : type.info);
    this.registry.set(key, property);
    this.entries.push({ code: key, property });
    return property;
  }

  registered(): { code: string; property: string }[] {
    return [...this.entries];
  }

  private mapping(schema: IRSchema): string | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

/** Named schemas that become their own C# type. */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

function constType(value: unknown): CsType {
  if (typeof value === 'string') return STRING;
  if (typeof value === 'boolean') return KEYWORD_TYPES['bool'] as CsType;
  if (typeof value === 'number') return KEYWORD_TYPES[Number.isInteger(value) ? 'long' : 'double'] as CsType;
  return JSON_ELEMENT;
}

/** A user-supplied type expression. */
function custom(code: string): CsType {
  const keyword = KEYWORD_TYPES[code];
  if (keyword) return keyword;
  const bare = code.replace(/^global::/, '').replace(/^System\./, '');
  const info = sanitize(bare.replace(/<.*$/, '').split('.').pop() ?? bare);
  return { code, valueType: SYSTEM_VALUE_TYPES.has(bare), info, friendly: info };
}
