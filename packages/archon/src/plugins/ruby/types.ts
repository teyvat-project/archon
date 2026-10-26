import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import type { RubyPluginOptions } from './index.js';
import type { RubyNames } from './names.js';

/**
 * A Ruby type: `expr` is the Core::Types expression that reads and writes it, `rbs` its RBS type, `doc` its YARD type,
 * and `model` the constant of the object model it is (for `coerce`).
 */
export type RubyType = { expr: string; rbs: string; doc: string; model?: string };

/** A type mapping: a built-in type name, or a Core::Types expression with its RBS type. */
export type RubyTypeMapping = BuiltinType | { type: string; rbs?: string; doc?: string };

export type BuiltinType = 'string' | 'integer' | 'number' | 'boolean' | 'time' | 'date' | 'bytes' | 'upload' | 'any';

const BUILTIN: Record<BuiltinType, RubyType> = {
  string: { expr: 'Core::Types::STRING', rbs: '::String', doc: '::String' },
  integer: { expr: 'Core::Types::INTEGER', rbs: '::Integer', doc: '::Integer' },
  number: { expr: 'Core::Types::NUMBER', rbs: '::Numeric', doc: '::Float' },
  boolean: { expr: 'Core::Types::BOOLEAN', rbs: 'bool', doc: 'Boolean' },
  time: { expr: 'Core::Types::TIME', rbs: '::Time', doc: '::Time' },
  date: { expr: 'Core::Types::DATE', rbs: '::Date', doc: '::Date' },
  bytes: { expr: 'Core::Types::BYTES', rbs: '::String', doc: '::String' },
  upload: { expr: 'Core::Types::UPLOAD', rbs: 'Core::Upload', doc: 'Core::Upload' },
  any: { expr: 'Core::Types::ANY', rbs: 'untyped', doc: 'Object' },
};

/** Maps IR schemas to Ruby types. */
export class RubyTypeResolver {
  constructor(
    private readonly ir: IRDocument,
    private readonly names: RubyNames,
    private readonly opts: RubyPluginOptions,
    private readonly diagnostics: Diagnostics,
  ) {}

  schema(schemaName: string): IRSchema | undefined {
    return this.ir.schemas.get(schemaName);
  }

  /**
   * The type of `schema`, without nullability of its own (see `nullable`); array items and map values accept nil
   * when their schema is nullable. Priority: `hooks.typeOverride` → `typeMappings['kind:format']` →
   * `typeMappings['kind']`.
   */
  typeOf(schema: IRSchema, path: SchemaPath, visiting: ReadonlySet<string> = new Set()): RubyType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    switch (schema.kind) {
      case 'string':
        if (schema.format === 'date-time') return BUILTIN.time;
        if (schema.format === 'date') return BUILTIN.date;
        if (schema.format === 'byte') return BUILTIN.bytes;
        return BUILTIN.string;
      case 'integer':
        return BUILTIN.integer;
      case 'number':
        return BUILTIN.number;
      case 'boolean':
        return BUILTIN.boolean;
      case 'binary':
        return BUILTIN.upload;
      case 'const':
        return constType(schema.value);
      case 'enum':
        // Inline enums are hoisted; one left inline maps to its base type.
        return schema.base === 'string' ? BUILTIN.string : schema.base === 'integer' ? BUILTIN.integer : BUILTIN.number;
      case 'array': {
        const item = this.element(schema.items, [...path, 'items'], visiting);
        return { expr: `Core::Types.array(${item.expr})`, rbs: `::Array[${item.rbs}]`, doc: `::Array<${item.doc}>` };
      }
      case 'object': {
        if (schema.properties.length > 0 || !schema.additionalProperties) return BUILTIN.any; // inline objects are hoisted
        const value = this.element(schema.additionalProperties, [...path, 'additionalProperties'], visiting);
        return { expr: `Core::Types.map(${value.expr})`, rbs: `::Hash[::String, ${value.rbs}]`, doc: `::Hash{::String => ${value.doc}}` };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to untyped JSON.`, schema.origin);
          return BUILTIN.any;
        }
        if (target.kind === 'enum') {
          const base = target.base === 'string' ? BUILTIN.string : target.base === 'integer' ? BUILTIN.integer : BUILTIN.number;
          return { ...base, doc: `${base.doc} (${name})` };
        }
        if (target.kind === 'union') return { expr: `Core::Types.ref(-> { ${name} })`, rbs: `${name}::t`, doc: name };
        if (isDeclared(target)) return { expr: `Core::Types.ref(-> { ${name} })`, rbs: name, doc: name, model: name };
        if (visiting.has(schema.name)) return BUILTIN.any;
        return this.typeOf(target, path, new Set(visiting).add(schema.name));
      }
      default:
        // null, unknown, tuple, unflattened intersection, inline union
        return BUILTIN.any;
    }
  }

  /** Whether a usage is nullable: the schema itself, or the named schema it refers to. */
  isNullable(schema: IRSchema): boolean {
    if (schema.nullable) return true;
    return schema.kind === 'ref' && this.ir.schemas.get(schema.name)?.nullable === true;
  }

  /** The named object schema a ref leads to (through aliases), if any. */
  objectTarget(schema: IRSchema, seen: ReadonlySet<string> = new Set()): string | undefined {
    if (schema.kind !== 'ref' || seen.has(schema.name)) return undefined;
    const target = this.ir.schemas.get(schema.name);
    if (target === undefined) return undefined;
    if (target.kind === 'object' && isDeclared(target)) return schema.name;
    return this.objectTarget(target, new Set(seen).add(schema.name));
  }

  private element(schema: IRSchema, path: SchemaPath, visiting: ReadonlySet<string>): RubyType {
    const type = this.typeOf(schema, path, visiting);
    return this.isNullable(schema) ? nullable(type) : type;
  }

  private mapping(schema: IRSchema): RubyTypeMapping | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

/** A type that also accepts nil. */
export function nullable(type: RubyType): RubyType {
  return { expr: `Core::Types.nullable(${type.expr})`, rbs: optional(type.rbs), doc: `${type.doc}, nil` };
}

/** `T?` (untyped stays as it is, unions are parenthesized). */
export function optional(rbs: string): string {
  if (rbs === 'untyped' || rbs.endsWith('?')) return rbs;
  return /[|&]/.test(rbs) ? `(${rbs})?` : `${rbs}?`;
}

/** Named schemas that become their own Ruby constant (object with properties, enum, union). */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

function constType(value: unknown): RubyType {
  if (typeof value === 'string') return BUILTIN.string;
  if (typeof value === 'boolean') return BUILTIN.boolean;
  if (typeof value === 'number') return Number.isInteger(value) ? BUILTIN.integer : BUILTIN.number;
  return BUILTIN.any;
}

function custom(mapping: RubyTypeMapping): RubyType {
  if (typeof mapping === 'string') return BUILTIN[mapping] ?? BUILTIN.any;
  return { expr: mapping.type, rbs: mapping.rbs ?? 'untyped', doc: mapping.doc ?? 'Object' };
}
