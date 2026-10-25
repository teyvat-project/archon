import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { toCase } from '../../writer/naming.js';
import type { RustPluginOptions } from './index.js';
import { bare, sanitize, type RsNames } from './names.js';

/**
 * A Rust type, a name for union variants (`friendly`), and whether it implements `Default` (so a struct holding it
 * can derive `Default`).
 */
export type RsType = { code: string; friendly: string; defaultable: boolean };

/** Where model types are referred from: `super::` inside `models`, `models::` in services. */
export type ModelPrefix = 'super::' | 'models::' | 'crate::models::';

const prim = (code: string, friendly: string): RsType => ({ code, friendly, defaultable: true });

const STRING = prim('String', 'String');
const I32 = prim('i32', 'Integer');
const I64 = prim('i64', 'Integer');
const F32 = prim('f32', 'Number');
const F64 = prim('f64', 'Number');
const BOOL = prim('bool', 'Boolean');
export const JSON_VALUE: RsType = prim('serde_json::Value', 'Json');
export const API_FILE: RsType = prim('crate::core::ApiFile', 'File');

/** Maps IR schemas to Rust types. */
export class RsTypeResolver {
  constructor(
    private readonly ir: IRDocument,
    private readonly names: RsNames,
    private readonly opts: RustPluginOptions,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** Whether a named schema becomes its own Rust type (object with properties, enum, union). */
  declares(schemaName: string): boolean {
    const schema = this.ir.schemas.get(schemaName);
    return schema !== undefined && isDeclared(schema);
  }

  schema(schemaName: string): IRSchema | undefined {
    return this.ir.schemas.get(schemaName);
  }

  /**
   * The Rust type of `schema`, without nullability of its own (see `usage`); array items and map values are
   * `Option` when their schema is nullable. Priority: `hooks.typeOverride` → `typeMappings['kind:format']` →
   * `typeMappings['kind']`.
   */
  typeOf(schema: IRSchema, path: SchemaPath, prefix: ModelPrefix, visiting: ReadonlySet<string> = new Set()): RsType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    switch (schema.kind) {
      case 'string':
        return STRING;
      case 'integer':
        return schema.format === 'int32' ? I32 : I64;
      case 'number':
        return schema.format === 'float' ? F32 : F64;
      case 'boolean':
        return BOOL;
      case 'binary':
        return API_FILE;
      case 'const':
        return { ...constType(schema.value), defaultable: false };
      case 'enum':
        // Inline enums are hoisted; one left inline maps to its base type.
        return schema.base === 'string' ? STRING : schema.base === 'integer' ? I64 : F64;
      case 'array': {
        const items = this.element(schema.items, [...path, 'items'], prefix, visiting);
        return { code: `Vec<${items.code}>`, friendly: `${items.friendly}List`, defaultable: true };
      }
      case 'object': {
        if (schema.properties.length > 0 || !schema.additionalProperties) return JSON_VALUE; // inline objects are hoisted
        const value = this.element(schema.additionalProperties, [...path, 'additionalProperties'], prefix, visiting);
        return { code: `std::collections::HashMap<String, ${value.code}>`, friendly: `${value.friendly}Map`, defaultable: true };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to serde_json::Value.`, schema.origin);
          return JSON_VALUE;
        }
        if (isDeclared(target)) {
          return { code: `${prefix}${name}`, friendly: bare(name), defaultable: false };
        }
        if (visiting.has(schema.name)) return JSON_VALUE;
        return this.typeOf(target, path, prefix, new Set(visiting).add(schema.name));
      }
      default:
        // null, unknown, tuple, unflattened intersection, inline union
        return JSON_VALUE;
    }
  }

  /** Whether a usage is nullable: the schema itself, or the named schema it refers to. */
  isNullable(schema: IRSchema): boolean {
    if (schema.nullable) return true;
    return schema.kind === 'ref' && this.ir.schemas.get(schema.name)?.nullable === true;
  }

  /** `typeOf`, wrapped in `Option` when the schema is nullable. */
  usage(schema: IRSchema, path: SchemaPath, prefix: ModelPrefix): RsType {
    const type = this.typeOf(schema, path, prefix);
    return this.isNullable(schema) ? option(type) : type;
  }

  private element(schema: IRSchema, path: SchemaPath, prefix: ModelPrefix, visiting: ReadonlySet<string>): RsType {
    const type = this.typeOf(schema, path, prefix, visiting);
    return this.isNullable(schema) ? option(type) : type;
  }

  private mapping(schema: IRSchema): string | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

export function option(type: RsType): RsType {
  return { code: `Option<${type.code}>`, friendly: type.friendly, defaultable: true };
}

/** Named schemas that become their own Rust type. */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

function constType(value: unknown): RsType {
  if (typeof value === 'string') return STRING;
  if (typeof value === 'boolean') return BOOL;
  if (typeof value === 'number') return Number.isInteger(value) ? I64 : F64;
  return JSON_VALUE;
}

/** A user-supplied type; whether it implements `Default` is unknown, so structs holding it do not derive it. */
function custom(type: string): RsType {
  const last = type.replace(/<.*$/, '').split('::').pop() ?? type;
  return { code: type, friendly: sanitize(toCase(last, 'PascalCase')), defaultable: false };
}
