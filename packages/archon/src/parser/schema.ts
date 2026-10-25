import type { Diagnostics } from '../diagnostics.js';
import type { IRProperty, IRSchema, IRSchemaBase } from '../ir/types.js';
import type { OpenAPIDocument } from '../loader/load.js';

export type SchemaContext = {
  doc: OpenAPIDocument;
  version: '3.0' | '3.1';
  diagnostics: Diagnostics;
  /** 現在の schema の JSON Pointer（`origin` と診断に使う） */
  pointer: string;
  /** インライン展開中の `$ref`（循環検出用）。呼び出し側は指定しない。 */
  refStack?: readonly string[];
};

type Obj = Record<string, unknown>;

/** `IRSchema` から `IRSchemaBase` を除いた、kind 固有の部分。 */
type KindPart = IRSchema extends infer T ? (T extends unknown ? Omit<T, keyof IRSchemaBase> : never) : never;

/** kind 固有の部分と、enum の `null` など構築中に判明した nullable。 */
type Built = { kind: KindPart; nullable?: boolean };

const COMPONENT_SCHEMA_PREFIX = '#/components/schemas/';
const COMPONENT_SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;
const UNSUPPORTED_KEYWORDS = ['not', 'if', 'then', 'else', 'patternProperties'] as const;

export function detectVersion(doc: OpenAPIDocument): '3.0' | '3.1' {
  return doc.openapi.startsWith('3.1') ? '3.1' : '3.0';
}

export function parseComponentSchemas(doc: OpenAPIDocument, ctx: SchemaContext): Map<string, IRSchema> {
  const out = new Map<string, IRSchema>();
  const schemas: unknown = doc['components']?.['schemas'];
  if (!isRecord(schemas)) return out;
  for (const [name, node] of Object.entries(schemas)) {
    out.set(name, parseSchema(node, { ...ctx, doc, pointer: `${COMPONENT_SCHEMA_PREFIX}${escapePointer(name)}` }));
  }
  return out;
}

export function parseSchema(node: unknown, ctx: SchemaContext): IRSchema {
  if (!isRecord(node)) return finish({ kind: 'unknown' }, false, undefined, ctx);

  const ref = node['$ref'];
  if (typeof ref === 'string') return parseRef(node, ref, ctx);

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) {
      ctx.diagnostics.warn('unsupported-keyword', `Keyword "${keyword}" is not supported and is ignored`, ctx.pointer);
    }
  }

  const { types, nullable } = readType(node);
  if (hasComposition(node)) return parseComposite(node, types, nullable, ctx);

  const built = buildKind(node, types, ctx);
  return finish(built.kind, nullable || built.nullable === true, node, ctx);
}

// ---------------------------------------------------------------------------
// $ref

function parseRef(node: Obj, ref: string, ctx: SchemaContext): IRSchema {
  const siblings = refSiblings(node);

  const component = COMPONENT_SCHEMA_REF.exec(ref);
  if (component?.[1] !== undefined) {
    const name = decodeSegment(component[1]);
    const schemas: unknown = ctx.doc['components']?.['schemas'];
    if (!isRecord(schemas) || !Object.hasOwn(schemas, name)) {
      return ctx.diagnostics.error('broken-ref', `Cannot resolve $ref "${ref}"`, ctx.pointer);
    }
    return finish({ kind: 'ref', name }, siblings['nullable'] === true, siblings, ctx);
  }

  if (!ref.startsWith('#/')) {
    return ctx.diagnostics.error('unsupported-ref', `Unsupported $ref "${ref}": only local references are supported`, ctx.pointer);
  }

  const stack = ctx.refStack ?? [];
  if (stack.includes(ref)) {
    return ctx.diagnostics.error('unsupported-ref', `Circular $ref "${ref}" outside components/schemas cannot be inlined`, ctx.pointer);
  }
  const target = resolvePointer(ctx.doc, ref);
  if (target === undefined) {
    return ctx.diagnostics.error('broken-ref', `Cannot resolve $ref "${ref}"`, ctx.pointer);
  }
  const inlined = parseSchema(target, { ...ctx, pointer: ref, refStack: [...stack, ref] });
  return { ...inlined, ...meta(siblings), nullable: inlined.nullable || siblings['nullable'] === true };
}

/** `$ref` の兄弟のうち IR に反映するもの（description / deprecated / readOnly / writeOnly / nullable）。 */
function refSiblings(node: Obj): Obj {
  const out: Obj = {};
  for (const key of ['description', 'deprecated', 'readOnly', 'writeOnly', 'nullable']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  return out;
}

function resolvePointer(doc: OpenAPIDocument, ref: string): unknown {
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    if (!isRecord(cur) && !Array.isArray(cur)) return undefined;
    const key = decodeSegment(raw);
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// allOf / oneOf / anyOf

function hasComposition(node: Obj): boolean {
  return Array.isArray(node['allOf']) || Array.isArray(node['oneOf']) || Array.isArray(node['anyOf']);
}

/** 合成キーワードと並んで書かれた、それ自身の形（`type` だけのものは意味を持たないので除く）。 */
function hasOwnShape(node: Obj): boolean {
  return (
    'properties' in node ||
    'additionalProperties' in node ||
    'items' in node ||
    'prefixItems' in node ||
    'enum' in node ||
    'const' in node
  );
}

function parseComposite(node: Obj, types: string[], nullable: boolean, ctx: SchemaContext): IRSchema {
  const parts: IRSchema[] = [];
  let isNullable = nullable;

  if (hasOwnShape(node)) {
    const own = buildKind(node, types, ctx);
    if (own.nullable) isNullable = true;
    parts.push(finish(own.kind, false, undefined, ctx));
  }

  const allOf = node['allOf'];
  if (Array.isArray(allOf)) {
    allOf.forEach((member, i) => parts.push(parseSchema(member, child(ctx, `allOf/${i}`))));
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const variants = node[key];
    if (Array.isArray(variants)) parts.push(buildUnion(variants, key, node, ctx));
  }

  if (!Array.isArray(allOf) && parts.length === 1 && parts[0]) {
    const [only] = parts;
    return { ...only, ...meta(node), nullable: only.nullable || isNullable, origin: ctx.pointer } as IRSchema;
  }
  return finish({ kind: 'intersection', members: parts }, isNullable, node, ctx);
}

function buildUnion(variants: unknown[], key: 'oneOf' | 'anyOf', node: Obj, ctx: SchemaContext): IRSchema {
  let nullable = false;
  const kept = variants
    .map((v, i) => parseSchema(v, child(ctx, `${key}/${i}`)))
    .filter((v) => {
      if (v.kind !== 'null') return true;
      nullable = true;
      return false;
    });

  const [first] = kept;
  if (!first) return finish({ kind: 'null' }, false, undefined, ctx);
  if (kept.length === 1 && nullable) return { ...first, nullable: true, origin: ctx.pointer };

  const discriminator = readDiscriminator(node['discriminator'], kept);
  return finish(
    discriminator ? { kind: 'union', variants: kept, discriminator } : { kind: 'union', variants: kept },
    nullable,
    undefined,
    ctx,
  );
}

function readDiscriminator(
  raw: unknown,
  variants: IRSchema[],
): { property: string; mapping: Map<string, string> } | undefined {
  if (!isRecord(raw) || typeof raw['propertyName'] !== 'string') return undefined;
  const mapping = new Map<string, string>();
  if (isRecord(raw['mapping'])) {
    for (const [value, target] of Object.entries(raw['mapping'])) {
      if (typeof target !== 'string') continue;
      mapping.set(value, target.startsWith(COMPONENT_SCHEMA_PREFIX) ? decodeSegment(target.slice(COMPONENT_SCHEMA_PREFIX.length)) : target);
    }
  }
  const mapped = new Set(mapping.values());
  for (const v of variants) {
    if (v.kind === 'ref' && !mapped.has(v.name)) mapping.set(v.name, v.name);
  }
  return { property: raw['propertyName'], mapping };
}

// ---------------------------------------------------------------------------
// type-driven kinds

function readType(node: Obj): { types: string[]; nullable: boolean } {
  const raw = node['type'];
  let types = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : typeof raw === 'string' ? [raw] : [];
  let nullable = node['nullable'] === true;
  if (types.length > 1 && types.includes('null')) {
    nullable = true;
    types = types.filter((t) => t !== 'null');
  }
  return { types, nullable };
}

function buildKind(node: Obj, types: string[], ctx: SchemaContext): Built {
  if ('const' in node) return { kind: { kind: 'const', value: node['const'] } };

  const [only] = types;
  if (types.length === 0) return inferKind(node, ctx);
  if (types.length === 1 && only !== undefined) return buildTyped(node, only, ctx);

  const variants = types.map((t) => {
    const b = buildTyped(node, t, ctx);
    return finish(b.kind, b.nullable === true, undefined, ctx);
  });
  return { kind: { kind: 'union', variants } };
}

function buildTyped(node: Obj, type: string, ctx: SchemaContext): Built {
  switch (type) {
    case 'string': {
      if (node['format'] === 'binary' || 'contentMediaType' in node || 'contentEncoding' in node) {
        return { kind: { kind: 'binary' } };
      }
      const e = buildEnum(node, 'string', (v): v is string => typeof v === 'string');
      if (e) return e;
      return {
        kind: {
          kind: 'string',
          ...(typeof node['format'] === 'string' && { format: node['format'] }),
          ...(typeof node['pattern'] === 'string' && { pattern: node['pattern'] }),
          ...(typeof node['minLength'] === 'number' && { minLength: node['minLength'] }),
          ...(typeof node['maxLength'] === 'number' && { maxLength: node['maxLength'] }),
        },
      };
    }
    case 'integer': {
      const e = buildEnum(node, 'integer', isNumber);
      if (e) return e;
      const format = node['format'];
      return { kind: { kind: 'integer', ...((format === 'int32' || format === 'int64') && { format }) } };
    }
    case 'number': {
      const e = buildEnum(node, 'number', isNumber);
      if (e) return e;
      const format = node['format'];
      return { kind: { kind: 'number', ...((format === 'float' || format === 'double') && { format }) } };
    }
    case 'boolean':
      return { kind: { kind: 'boolean' } };
    case 'null':
      return { kind: { kind: 'null' } };
    case 'array':
      return { kind: buildArray(node, ctx) };
    case 'object':
      return { kind: buildObject(node, ctx) };
    default:
      ctx.diagnostics.warn('unsupported-type', `Unsupported type "${type}" is treated as unknown`, ctx.pointer);
      return { kind: { kind: 'unknown' } };
  }
}

/** `type` が無いときに他のキーワードから kind を推定する。 */
function inferKind(node: Obj, ctx: SchemaContext): Built {
  if ('properties' in node || 'additionalProperties' in node) return { kind: buildObject(node, ctx) };
  if ('items' in node || 'prefixItems' in node) return { kind: buildArray(node, ctx) };

  const values = node['enum'];
  if (!Array.isArray(values)) return { kind: { kind: 'unknown' } };

  const nonNull = values.filter((v) => v !== null);
  if (nonNull.length === 0) return { kind: { kind: 'null' } };
  if (nonNull.every((v) => typeof v === 'string')) return buildEnum(node, 'string', (v): v is string => typeof v === 'string') ?? { kind: { kind: 'unknown' } };
  if (nonNull.every(isNumber)) {
    return buildEnum(node, nonNull.every(Number.isInteger) ? 'integer' : 'number', isNumber) ?? { kind: { kind: 'unknown' } };
  }
  return { kind: { kind: 'unknown' } };
}

/** `enum` から enum kind を作る。`null` は値から除いて nullable にする。値が残らなければ undefined。 */
function buildEnum<T extends string | number>(
  node: Obj,
  base: 'string' | 'integer' | 'number',
  accept: (v: unknown) => v is T,
): Built | undefined {
  const raw = node['enum'];
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter(accept);
  if (values.length === 0) return undefined;
  return { kind: { kind: 'enum', base, values }, nullable: raw.includes(null) };
}

function buildArray(node: Obj, ctx: SchemaContext): KindPart {
  const prefix = node['prefixItems'];
  if (Array.isArray(prefix)) {
    const items = prefix.map((s, i) => parseSchema(s, child(ctx, `prefixItems/${i}`)));
    const rest = node['items'];
    return isRecord(rest) ? { kind: 'tuple', items, rest: parseSchema(rest, child(ctx, 'items')) } : { kind: 'tuple', items };
  }
  return {
    kind: 'array',
    items: parseSchema(node['items'], child(ctx, 'items')),
    ...(node['uniqueItems'] === true && { uniqueItems: true }),
  };
}

function buildObject(node: Obj, ctx: SchemaContext): KindPart {
  const required = new Set(Array.isArray(node['required']) ? node['required'].filter((r): r is string => typeof r === 'string') : []);
  const rawProps = node['properties'];
  const properties: IRProperty[] = isRecord(rawProps)
    ? Object.entries(rawProps).map(([name, schema]) => ({
        name,
        schema: parseSchema(schema, child(ctx, `properties/${escapePointer(name)}`)),
        required: required.has(name),
      }))
    : [];

  const ap = node['additionalProperties'];
  if (ap === undefined) return { kind: 'object', properties };
  return {
    kind: 'object',
    properties,
    additionalProperties: ap === false ? false : parseSchema(ap, child(ctx, 'additionalProperties')),
  };
}

// ---------------------------------------------------------------------------
// helpers

function finish(kind: KindPart, nullable: boolean, metaSource: Obj | undefined, ctx: SchemaContext): IRSchema {
  return { ...kind, ...meta(metaSource), nullable, origin: ctx.pointer } as IRSchema;
}

/** 定義されているメタ項目だけを取り出す。 */
function meta(node: Obj | undefined): Partial<IRSchemaBase> {
  if (!node) return {};
  return {
    ...(typeof node['title'] === 'string' && { title: node['title'] }),
    ...(typeof node['description'] === 'string' && { description: node['description'] }),
    ...(typeof node['deprecated'] === 'boolean' && { deprecated: node['deprecated'] }),
    ...('default' in node && { default: node['default'] }),
    ...('example' in node && { example: node['example'] }),
    ...(typeof node['readOnly'] === 'boolean' && { readOnly: node['readOnly'] }),
    ...(typeof node['writeOnly'] === 'boolean' && { writeOnly: node['writeOnly'] }),
  };
}

function child(ctx: SchemaContext, segments: string): SchemaContext {
  return { ...ctx, pointer: `${ctx.pointer}/${segments}` };
}

function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function decodeSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}
