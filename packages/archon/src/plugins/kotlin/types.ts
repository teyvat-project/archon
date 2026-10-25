import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import type { KotlinPluginOptions } from './index.js';
import { bare, packageCode, sanitize, type KtNames } from './names.js';

/** A Kotlin type, the expression of its `KSerializer`, and a name for union wrappers (`friendly` + `Value`). */
export type KtType = { code: string; serializer: string; friendly: string };

/** A type mapping: a Kotlin type, optionally with its serializer expression (default `<type>.serializer()`). */
export type KtTypeMapping = string | { type: string; serializer: string };

const prim = (code: string): KtType => ({ code, serializer: `${code}.serializer()`, friendly: code });

const STRING = prim('String');
const INT = prim('Int');
const LONG = prim('Long');
const DOUBLE = prim('Double');
const FLOAT = prim('Float');
const BOOLEAN = prim('Boolean');
const JSON_ELEMENT: KtType = { code: 'JsonElement', serializer: 'JsonElement.serializer()', friendly: 'Json' };
const API_FILE: KtType = { code: 'ApiFile', serializer: 'ApiFile.Serializer', friendly: 'ApiFile' };

/** Maps IR schemas to Kotlin types with explicit serializer expressions (no reflective serializer lookup). */
export class KtTypeResolver {
  constructor(
    private readonly ir: IRDocument,
    private readonly names: KtNames,
    private readonly opts: KotlinPluginOptions,
    private readonly diagnostics: Diagnostics,
    readonly packageName: string,
  ) {}

  /** Whether a named schema becomes its own Kotlin type (object with properties, enum, union). */
  declares(schemaName: string): boolean {
    const schema = this.ir.schemas.get(schemaName);
    return schema !== undefined && isDeclared(schema);
  }

  schema(schemaName: string): IRSchema | undefined {
    return this.ir.schemas.get(schemaName);
  }

  /** The package of the models, as written in code. */
  get modelsPackage(): string {
    return `${packageCode(this.packageName)}.models`;
  }

  /**
   * The Kotlin type of `schema`, without nullability of its own (see `nullable`); nested items and map values are
   * nullable when their schema is. `qualified` writes model types with their package (inside a union, nested
   * classes can hide model names). Priority: `hooks.typeOverride` → `typeMappings['kind:format']` → `typeMappings['kind']`.
   */
  typeOf(schema: IRSchema, path: SchemaPath, o: { qualified?: boolean } = {}, visiting: ReadonlySet<string> = new Set()): KtType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    switch (schema.kind) {
      case 'string':
        return STRING;
      case 'integer':
        return schema.format === 'int64' ? LONG : INT;
      case 'number':
        return schema.format === 'float' ? FLOAT : DOUBLE;
      case 'boolean':
        return BOOLEAN;
      case 'binary':
        return API_FILE;
      case 'const':
        return constType(schema.value);
      case 'enum':
        // Inline enums are hoisted; one left inline maps to its base type.
        return schema.base === 'string' ? STRING : schema.base === 'integer' ? LONG : DOUBLE;
      case 'array': {
        const items = this.element(schema.items, [...path, 'items'], o, visiting);
        return { code: `List<${items.code}>`, serializer: `ListSerializer(${items.serializer})`, friendly: `${items.friendly}List` };
      }
      case 'object': {
        if (schema.properties.length > 0 || !schema.additionalProperties) return JSON_ELEMENT; // inline objects are hoisted
        const value = this.element(schema.additionalProperties, [...path, 'additionalProperties'], o, visiting);
        return {
          code: `Map<String, ${value.code}>`,
          serializer: `MapSerializer(String.serializer(), ${value.serializer})`,
          friendly: `${value.friendly}Map`,
        };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to JsonElement.`, schema.origin);
          return JSON_ELEMENT;
        }
        if (isDeclared(target)) {
          const code = o.qualified ? `${this.modelsPackage}.${name}` : name;
          return { code, serializer: target.kind === 'object' ? `${code}.serializer()` : `${code}.Serializer`, friendly: bare(name) };
        }
        if (visiting.has(schema.name)) return JSON_ELEMENT;
        return this.typeOf(target, path, o, new Set(visiting).add(schema.name));
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

  nullable(type: KtType): KtType {
    return { code: `${type.code}?`, serializer: `${type.serializer}.nullable`, friendly: type.friendly };
  }

  /** `typeOf`, made nullable when the schema is. */
  usage(schema: IRSchema, path: SchemaPath, o: { qualified?: boolean } = {}): KtType {
    const type = this.typeOf(schema, path, o);
    return this.isNullable(schema) ? this.nullable(type) : type;
  }

  private element(schema: IRSchema, path: SchemaPath, o: { qualified?: boolean }, visiting: ReadonlySet<string>): KtType {
    const type = this.typeOf(schema, path, o, visiting);
    return this.isNullable(schema) ? this.nullable(type) : type;
  }

  private mapping(schema: IRSchema): KtTypeMapping | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

/** Named schemas that become their own Kotlin type. */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

function constType(value: unknown): KtType {
  if (typeof value === 'string') return STRING;
  if (typeof value === 'boolean') return BOOLEAN;
  if (typeof value === 'number') return Number.isInteger(value) ? LONG : DOUBLE;
  return JSON_ELEMENT;
}

/** A user-supplied type. */
function custom(mapping: KtTypeMapping): KtType {
  const { type, serializer } = typeof mapping === 'string' ? { type: mapping, serializer: `${mapping}.serializer()` } : mapping;
  const simple = type.replace(/<.*$/, '').replace(/\?$/, '').split('.').pop() ?? type;
  return { code: type, serializer, friendly: sanitize(bare(simple)) };
}
