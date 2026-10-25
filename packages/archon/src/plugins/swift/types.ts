import type { Diagnostics } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import type { SwiftPluginOptions } from './index.js';
import { sanitize, type SwNames } from './names.js';

/**
 * A Swift type expression (without optionality). `friendly` names it for union case names; `declared` is the named
 * schema the expression is exactly (not an array or dictionary of it), for value-cycle detection.
 */
export type SwType = { code: string; friendly: string; declared?: string };

/** Maps IR schemas to Swift types. */
export class SwTypeResolver {
  constructor(
    private readonly ir: IRDocument,
    private readonly names: SwNames,
    private readonly opts: SwiftPluginOptions,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** Whether a named schema becomes its own Swift type (object with properties, enum, union). */
  declares(schemaName: string): boolean {
    const schema = this.ir.schemas.get(schemaName);
    return schema !== undefined && isDeclared(schema);
  }

  schema(schemaName: string): IRSchema | undefined {
    return this.ir.schemas.get(schemaName);
  }

  std: SwNames['std'] = (name) => this.names.std(name);

  /** The runtime's `JSONValue` (unknown / null / tuples / unflattened intersections / dropped inline unions). */
  get json(): SwType {
    return { code: 'JSONValue', friendly: 'Json' };
  }

  /** Priority: `hooks.typeOverride` → `typeMappings['kind:format']` → `typeMappings['kind']`. */
  typeOf(schema: IRSchema, path: SchemaPath, visiting: ReadonlySet<string> = new Set()): SwType {
    const override = this.opts.hooks.typeOverride?.(schema, { path });
    if (override !== undefined) return custom(override);
    const mapped = this.mapping(schema);
    if (mapped !== undefined) return custom(mapped);

    const std = (name: Parameters<SwNames['std']>[0], friendly: string = name): SwType => ({ code: this.std(name), friendly });
    switch (schema.kind) {
      case 'string':
        switch (schema.format) {
          case 'date-time':
            return std('Date');
          case 'date':
            return { code: 'CalendarDate', friendly: 'CalendarDate' };
          case 'uuid':
            return std('UUID', 'Uuid');
          case 'byte':
            return std('Data');
          default:
            return std('String');
        }
      case 'integer':
        return std(schema.format === 'int64' ? 'Int64' : schema.format === 'int32' ? 'Int32' : 'Int');
      case 'number':
        return std(schema.format === 'float' ? 'Float' : 'Double');
      case 'boolean':
        return std('Bool');
      case 'binary':
        return { code: 'ApiFile', friendly: 'File' };
      case 'const':
        if (typeof schema.value === 'string') return std('String');
        if (typeof schema.value === 'boolean') return std('Bool');
        if (typeof schema.value === 'number') return std(Number.isInteger(schema.value) ? 'Int' : 'Double');
        return this.json;
      case 'enum':
        // Inline enums are hoisted; one left inline (a dropped discriminator) maps to its base type.
        return std(schema.base === 'string' ? 'String' : schema.base === 'integer' ? 'Int' : 'Double');
      case 'array': {
        const items = this.typeOf(schema.items, [...path, 'items'], visiting);
        return { code: `[${items.code}]`, friendly: `${items.friendly}List` };
      }
      case 'object': {
        if (schema.properties.length > 0) return this.json; // inline objects are hoisted
        const value = schema.additionalProperties ? this.typeOf(schema.additionalProperties, [...path, 'additionalProperties'], visiting) : this.json;
        return { code: `[${this.std('String')}: ${value.code}]`, friendly: `${value.friendly}Map` };
      }
      case 'ref': {
        const target = this.ir.schemas.get(schema.name);
        const name = this.names.types.get(schema.name);
        if (target === undefined || name === undefined) {
          this.diagnostics.warn('unknown-schema', `Unknown schema "${schema.name}" is mapped to JSONValue.`, schema.origin);
          return this.json;
        }
        if (isDeclared(target)) return { code: name, friendly: name, declared: schema.name };
        if (visiting.has(schema.name)) return this.json;
        return this.typeOf(target, path, new Set(visiting).add(schema.name));
      }
      default:
        // null, unknown, tuple, unflattened intersection, inline union
        return this.json;
    }
  }

  /** Whether a usage is nullable: the schema itself, or the named schema it refers to. */
  isNullable(schema: IRSchema): boolean {
    if (schema.nullable) return true;
    return schema.kind === 'ref' && this.ir.schemas.get(schema.name)?.nullable === true;
  }

  private mapping(schema: IRSchema): string | undefined {
    if (!['string', 'integer', 'number', 'boolean'].includes(schema.kind)) return undefined;
    const format = 'format' in schema ? schema.format : undefined;
    return (format !== undefined ? this.opts.typeMappings[`${schema.kind}:${format}`] : undefined) ?? this.opts.typeMappings[schema.kind];
  }
}

/** Named schemas that become their own Swift type. */
export function isDeclared(schema: IRSchema): boolean {
  return (schema.kind === 'object' && schema.properties.length > 0) || schema.kind === 'enum' || schema.kind === 'union';
}

export function optional(code: string, nullable: boolean): string {
  return nullable ? `${code}?` : code;
}

/** A user-supplied type expression. */
function custom(code: string): SwType {
  const base = code.replace(/[?!]+$/, '').replace(/<.*$/, '').split('.').pop() ?? code;
  return { code, friendly: sanitize(base.replace(/[[\]: ]/g, '')) };
}

/**
 * Struct properties that must be stored out of line (`Indirect`): those whose type is, by value, a struct in the same
 * strongly connected component of the "contains by value" graph (`Node.parent: Node?`, `A.b: B?` + `B.a: A?`).
 * Arrays and dictionaries store their elements on the heap and unions are `indirect enum`s, so neither adds edges.
 * Keys are `<schema>\0<property wire name>`.
 */
export function boxedProperties(ir: IRDocument, resolver: SwTypeResolver): Set<string> {
  const edges = new Map<string, { property: string; target: string }[]>();
  for (const [name, schema] of ir.schemas) {
    if (schema.kind !== 'object' || schema.properties.length === 0) continue;
    const out: { property: string; target: string }[] = [];
    for (const p of schema.properties) {
      const target = resolver.typeOf(p.schema, ['schemas', name, 'properties', p.name]).declared;
      if (target !== undefined && resolver.schema(target)?.kind === 'object') out.push({ property: p.name, target });
    }
    edges.set(name, out);
  }

  // Tarjan's strongly connected components.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  let components = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const { target } of edges.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node) as number, low.get(target) as number));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) as number, index.get(target) as number));
      }
    }
    if (low.get(node) === index.get(node)) {
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        component.set(member, components);
        if (member === node) break;
      }
      components++;
    }
  };
  for (const node of edges.keys()) if (!index.has(node)) visit(node);

  const boxed = new Set<string>();
  for (const [node, out] of edges) {
    for (const { property, target } of out) {
      if (component.get(node) === component.get(target)) boxed.add(`${node}\0${property}`);
    }
  }
  return boxed;
}
