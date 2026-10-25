import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument, IRProperty, IRSchema } from '../ir/types.js';
import { mapDocumentSchemas } from '../ir/walk.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type Intersection = Extract<IRSchema, { kind: 'intersection' }>;

/** `object`: 合成済み、`mismatch`: object でないメンバーがある、`unresolved`: ref が解決できない / 循環している。 */
type Resolved = { status: 'object'; schema: ObjectSchema } | { status: 'mismatch' } | { status: 'unresolved' };

const MISMATCH: Resolved = { status: 'mismatch' };
const UNRESOLVED: Resolved = { status: 'unresolved' };

/**
 * member を object として解決する。`ref` は named schema をたどり（`visiting` で循環を検出）、
 * 名前付き intersection もその場で合成する。
 */
function resolveObject(schema: IRSchema, ir: IRDocument, visiting: ReadonlySet<string>): Resolved {
  switch (schema.kind) {
    case 'object':
      return { status: 'object', schema };
    case 'ref': {
      if (visiting.has(schema.name)) return UNRESOLVED;
      const target = ir.schemas.get(schema.name);
      if (!target) return UNRESOLVED;
      return resolveObject(target, ir, new Set(visiting).add(schema.name));
    }
    case 'intersection':
      return merge(schema, ir, visiting);
    default:
      return MISMATCH;
  }
}

/** メンバーを合成する。同名プロパティは後勝ち（位置は初出のまま）、required は OR、additionalProperties は最後の指定。 */
function merge(schema: Intersection, ir: IRDocument, visiting: ReadonlySet<string>): Resolved {
  const { members, ...own } = schema;
  const properties = new Map<string, IRProperty>();
  let additionalProperties: ObjectSchema['additionalProperties'];
  let mismatch = false;

  for (const member of members) {
    const resolved = resolveObject(member, ir, visiting);
    if (resolved.status === 'unresolved') return UNRESOLVED;
    if (resolved.status === 'mismatch') {
      mismatch = true;
      continue;
    }
    for (const p of resolved.schema.properties) {
      const prev = properties.get(p.name);
      properties.set(p.name, { ...p, required: p.required || (prev?.required ?? false) });
    }
    if (resolved.schema.additionalProperties !== undefined) {
      additionalProperties = resolved.schema.additionalProperties;
    }
  }
  if (mismatch) return MISMATCH;

  const object: ObjectSchema =
    additionalProperties === undefined
      ? { ...own, kind: 'object', properties: [...properties.values()] }
      : { ...own, kind: 'object', properties: [...properties.values()], additionalProperties };
  return { status: 'object', schema: object };
}

/**
 * 全メンバーが object（または object に解決できる ref）の `intersection` を、プロパティを合成した
 * `object` に置き換える。object 以外が含まれる場合はそのまま残す。ref が解決できない / 循環する場合も
 * 残した上で `allof-not-flattened` を info に記録する。
 */
export function flattenAllOf(ir: IRDocument, diagnostics: Diagnostics): void {
  mapDocumentSchemas(ir, (schema) => {
    if (schema.kind !== 'intersection') return schema;
    const merged = merge(schema, ir, new Set());
    if (merged.status === 'object') return merged.schema;
    if (merged.status === 'unresolved') {
      diagnostics.info(
        'allof-not-flattened',
        'allOf was not flattened: a $ref member could not be resolved (missing or cyclic).',
        schema.origin,
      );
    }
    return schema;
  });
}
