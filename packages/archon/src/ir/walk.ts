import type { IRDocument, IRSchema } from './types.js';

/**
 * schema の位置を表すパス。例: `['schemas', 'Status', 'properties', 'author']`。
 *
 * 子 schema のセグメント:
 * - object: `properties`, <name> / `additionalProperties`
 * - array: `items`
 * - tuple: `items`, <index> / `rest`
 * - union: `variants`, <index>
 * - intersection: `members`, <index>
 *
 * `visitSchemas` が使うルートのセグメント:
 * - `['schemas', <name>]`
 * - `['operations', <op.id>, 'parameters', <param.name>]`
 * - `['operations', <op.id>, 'requestBody', <mediaType>]`
 * - `['operations', <op.id>, 'responses', <String(status)>, <mediaType>]`
 * - `['operations', <op.id>, 'responses', <String(status)>, 'headers', <header name>]`
 */
export type SchemaPath = string[];

/** 直接の子 schema とそのパスセグメントを返す。 */
function children(schema: IRSchema): { segments: string[]; schema: IRSchema }[] {
  switch (schema.kind) {
    case 'array':
      return [{ segments: ['items'], schema: schema.items }];
    case 'tuple': {
      const out = schema.items.map((s, i) => ({ segments: ['items', String(i)], schema: s }));
      if (schema.rest) out.push({ segments: ['rest'], schema: schema.rest });
      return out;
    }
    case 'object': {
      const out = schema.properties.map((p) => ({ segments: ['properties', p.name], schema: p.schema }));
      if (schema.additionalProperties) {
        out.push({ segments: ['additionalProperties'], schema: schema.additionalProperties });
      }
      return out;
    }
    case 'union':
      return schema.variants.map((s, i) => ({ segments: ['variants', String(i)], schema: s }));
    case 'intersection':
      return schema.members.map((s, i) => ({ segments: ['members', String(i)], schema: s }));
    default:
      return [];
  }
}

function visit(schema: IRSchema, path: SchemaPath, fn: (s: IRSchema, p: SchemaPath) => void): void {
  fn(schema, path);
  for (const child of children(schema)) visit(child.schema, [...path, ...child.segments], fn);
}

/**
 * named schemas → operations（parameters / requestBody / responses）の順に、
 * 親 → 子の深さ優先で走査する。`ref` は辿らない（ノードとしては訪問する）。
 */
export function visitSchemas(ir: IRDocument, fn: (schema: IRSchema, path: SchemaPath) => void): void {
  for (const [name, schema] of ir.schemas) visit(schema, ['schemas', name], fn);
  for (const op of ir.operations) {
    const base = ['operations', op.id];
    for (const p of op.parameters) visit(p.schema, [...base, 'parameters', p.name], fn);
    for (const c of op.requestBody?.contents ?? []) visit(c.schema, [...base, 'requestBody', c.mediaType], fn);
    for (const r of op.responses) {
      const rbase = [...base, 'responses', String(r.status)];
      for (const [name, schema] of r.headers) visit(schema, [...rbase, 'headers', name], fn);
      for (const c of r.contents) visit(c.schema, [...rbase, c.mediaType], fn);
    }
  }
}

/** 子 → 親の順に置換した新しい schema を返す（入力は変更しない）。 */
export function mapSchema(
  schema: IRSchema,
  fn: (s: IRSchema, path: SchemaPath) => IRSchema,
  path: SchemaPath = [],
): IRSchema {
  const at = (child: IRSchema, ...segments: string[]) => mapSchema(child, fn, [...path, ...segments]);
  let next: IRSchema = schema;
  switch (schema.kind) {
    case 'array':
      next = { ...schema, items: at(schema.items, 'items') };
      break;
    case 'tuple': {
      const items = schema.items.map((s, i) => at(s, 'items', String(i)));
      next = schema.rest ? { ...schema, items, rest: at(schema.rest, 'rest') } : { ...schema, items };
      break;
    }
    case 'object': {
      const properties = schema.properties.map((p) => ({ ...p, schema: at(p.schema, 'properties', p.name) }));
      next = schema.additionalProperties
        ? { ...schema, properties, additionalProperties: at(schema.additionalProperties, 'additionalProperties') }
        : { ...schema, properties };
      break;
    }
    case 'union':
      next = { ...schema, variants: schema.variants.map((s, i) => at(s, 'variants', String(i))) };
      break;
    case 'intersection':
      next = { ...schema, members: schema.members.map((s, i) => at(s, 'members', String(i))) };
      break;
    default:
      break;
  }
  return fn(next, path);
}

/** schema 内（ネスト含む）の `ref` が指す名前を集める。 */
export function collectRefs(schema: IRSchema): Set<string> {
  const refs = new Set<string>();
  visit(schema, [], (s) => {
    if (s.kind === 'ref') refs.add(s.name);
  });
  return refs;
}

/**
 * named schemas と operation 配下の全 schema（parameters / requestBody / responses の headers と contents）に
 * `mapSchema(schema, fn)` を適用し、`ir` をその場で書き換える。
 */
export function mapDocumentSchemas(ir: IRDocument, fn: (s: IRSchema, path: SchemaPath) => IRSchema): void {
  const map = (schema: IRSchema, ...root: string[]) => mapSchema(schema, fn, root);

  for (const [name, schema] of ir.schemas) ir.schemas.set(name, map(schema, 'schemas', name));
  for (const op of ir.operations) {
    const base = ['operations', op.id];
    for (const p of op.parameters) p.schema = map(p.schema, ...base, 'parameters', p.name);
    for (const c of op.requestBody?.contents ?? []) c.schema = map(c.schema, ...base, 'requestBody', c.mediaType);
    for (const r of op.responses) {
      const rbase = [...base, 'responses', String(r.status)];
      for (const [name, schema] of r.headers) r.headers.set(name, map(schema, ...rbase, 'headers', name));
      for (const c of r.contents) c.schema = map(c.schema, ...rbase, c.mediaType);
    }
  }
}
