import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import type { GoPluginOptions } from './index.js';
import { exported, type GoNames } from './names.js';

/**
 * A Go type. `nilable` types (slices, maps, pointers, json.RawMessage) express "absent" themselves and are never
 * wrapped in a pointer; `model` is set for named structs (objects and unions), which successful responses return
 * as pointers; `friendly` names a union variant field; `json` is the JSON shape the type reads (union guards);
 * `imports` are the import paths of mapped types (standard packages are found from the code itself).
 */
export type GoType = {
  code: string;
  friendly: string;
  nilable: boolean;
  model?: boolean;
  json?: 'object' | 'array' | 'string' | 'number' | 'boolean';
  imports?: string[];
};

/** A type mapping: a Go type, optionally with the import path it needs. */
export type GoTypeMapping = string | { type: string; import?: string };

const prim = (code: string, friendly: string, json: GoType['json']): GoType => ({ code, friendly, nilable: false, json });

const STRING = prim('string', 'String', 'string');
const INT = prim('int', 'Int', 'number');
const INT32 = prim('int32', 'Int32', 'number');
const INT64 = prim('int64', 'Int64', 'number');
const FLOAT64 = prim('float64', 'Float64', 'number');
const FLOAT32 = prim('float32', 'Float32', 'number');
const BOOL = prim('bool', 'Bool', 'boolean');
const TIME = prim('time.Time', 'Time', 'string');
const DATE = prim('core.Date', 'Date', 'string');
const FILE = prim('core.File', 'File', 'string');
const BYTES: GoType = { code: '[]byte', friendly: 'Bytes', nilable: true, json: 'string' };
const RAW: GoType = { code: 'json.RawMessage', friendly: 'JSON', nilable: true };

/** Maps IR schemas to Go types. */
export class GoTypeResolver {
  constructor(
    private readonly ir: IRDocument,
    private readonly names: GoNames,
    private readonly opts: GoPluginOptions,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** Whether a named schema becomes its own Go type (object with properties, enum, union). */
  declares(schemaName: string): boolean {
    const schema = this.ir.schemas.get(schemaName);
    return schema !== undefined && isDeclared(schema);
  }

  schema(schemaName: string): IRSchema | undefined {
    return this.ir.schemas.get(schemaName);
  }

  /**
   * The Go type of `schema`, without nullability of its own (see `field` / `pointer`); array items and map values
   * are pointers when their schema is nullable. Priority: `hooks.typeOverride` → `typeMappings['kind:format']` →
   * `typeMappings['kind']`.
   */
  typeOf(schema: IRSchema, path: SchemaPath, visiting: ReadonlySet<string> = new Set()): GoType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    switch (schema.kind) {
      case 'string':
        if (schema.format === 'date-time') return TIME;
        if (schema.format === 'date') return DATE;
        if (schema.format === 'byte') return BYTES;
        return STRING;
      case 'integer':
        return schema.format === 'int64' ? INT64 : schema.format === 'int32' ? INT32 : INT;
      case 'number':
        return schema.format === 'float' ? FLOAT32 : FLOAT64;
      case 'boolean':
        return BOOL;
      case 'binary':
        return FILE;
      case 'const':
        return constType(schema.value);
      case 'enum':
        // Inline enums are hoisted; one left inline maps to its base type.
        return schema.base === 'string' ? STRING : schema.base === 'integer' ? INT64 : FLOAT64;
      case 'array': {
        const items = this.element(schema.items, [...path, 'items'], visiting);
        return { code: `[]${items.code}`, friendly: `${items.friendly}List`, nilable: true, json: 'array', imports: items.imports };
      }
      case 'object': {
        if (schema.properties.length > 0 || !schema.additionalProperties) return RAW; // inline objects are hoisted
        const value = this.element(schema.additionalProperties, [...path, 'additionalProperties'], visiting);
        return { code: `map[string]${value.code}`, friendly: `${value.friendly}Map`, nilable: true, json: 'object', imports: value.imports };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to json.RawMessage.`, schema.origin);
          return RAW;
        }
        if (target.kind === 'enum') {
          return { code: name, friendly: name, nilable: false, json: target.base === 'string' ? 'string' : 'number' };
        }
        if (isDeclared(target)) {
          // A discriminated union reads objects only.
          const json = target.kind === 'object' || (target.kind === 'union' && target.discriminator) ? 'object' : undefined;
          return { code: name, friendly: name, nilable: false, model: true, json };
        }
        if (visiting.has(schema.name)) return RAW;
        return this.typeOf(target, path, new Set(visiting).add(schema.name));
      }
      default:
        // null, unknown, tuple, unflattened intersection, inline union
        return RAW;
    }
  }

  /** Whether a usage is nullable: the schema itself, or the named schema it refers to. */
  isNullable(schema: IRSchema): boolean {
    if (schema.nullable) return true;
    return schema.kind === 'ref' && this.ir.schemas.get(schema.name)?.nullable === true;
  }

  /** `*T` (a nilable type stays as it is). */
  pointer(type: GoType): GoType {
    return type.nilable ? type : { ...type, code: `*${type.code}`, nilable: true, model: false };
  }

  /** The named object schema a ref leads to (through aliases), if any. */
  objectTarget(schema: IRSchema, seen: ReadonlySet<string> = new Set()): string | undefined {
    if (schema.kind !== 'ref' || seen.has(schema.name)) return undefined;
    const target = this.ir.schemas.get(schema.name);
    if (target === undefined) return undefined;
    if (target.kind === 'object' && isDeclared(target)) return schema.name;
    return this.objectTarget(target, new Set(seen).add(schema.name));
  }

  private element(schema: IRSchema, path: SchemaPath, visiting: ReadonlySet<string>): GoType {
    const type = this.typeOf(schema, path, visiting);
    return this.isNullable(schema) ? this.pointer(type) : type;
  }

  private mapping(schema: IRSchema): GoTypeMapping | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

/** Named schemas that become their own Go type. */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

function constType(value: unknown): GoType {
  if (typeof value === 'string') return STRING;
  if (typeof value === 'boolean') return BOOL;
  if (typeof value === 'number') return Number.isInteger(value) ? INT64 : FLOAT64;
  return RAW;
}

/** A user-supplied type; `*T`, `[]T` and `map[...]` are nilable. */
function custom(mapping: GoTypeMapping): GoType {
  const { type, import: path } = typeof mapping === 'string' ? { type: mapping, import: undefined } : mapping;
  const friendly = exported(type.replace(/^[*[\]]+/, '').split('.').pop()?.replace(/[^A-Za-z0-9_]/g, '') ?? 'Value');
  const builtin = ['string', 'bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64'];
  const json: GoType['json'] = type === 'string' ? 'string' : type === 'bool' ? 'boolean' : builtin.includes(type) ? 'number' : undefined;
  return { code: type, friendly, nilable: /^(\*|\[\]|map\[)/.test(type), json, ...(path ? { imports: [path] } : {}) };
}
