import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument, IRProperty, IRSchema } from '../ir/types.js';
import { mapDocumentSchemas, mapSchema } from '../ir/walk.js';

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
function resolveObject(
  schema: IRSchema,
  ir: IRDocument,
  visiting: ReadonlySet<string>,
  refs: Set<string>,
): Resolved {
  switch (schema.kind) {
    case 'object':
      return { status: 'object', schema };
    case 'ref': {
      if (visiting.has(schema.name)) return UNRESOLVED;
      refs.add(schema.name);
      const target = ir.schemas.get(schema.name);
      if (!target) return UNRESOLVED;
      return resolveObject(target, ir, new Set(visiting).add(schema.name), refs);
    }
    case 'intersection':
      return merge(schema, ir, visiting, refs);
    default:
      return MISMATCH;
  }
}

/** メンバーを合成する。同名プロパティは後勝ち（位置は初出のまま）、required は OR、additionalProperties は最後の指定。 */
function merge(
  schema: Intersection,
  ir: IRDocument,
  visiting: ReadonlySet<string>,
  refs: Set<string>,
): Resolved {
  const { members, ...own } = schema;
  const properties = new Map<string, IRProperty>();
  let additionalProperties: ObjectSchema['additionalProperties'];
  let mismatch = false;

  for (const member of members) {
    const resolved = resolveObject(member, ir, visiting, refs);
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
 * 残した上で `allof-not-flattened` を info に記録する（同じ `origin` は 1 回だけ）。
 *
 * 合成で取り込んだ ref 先のプロパティには未平坦化の intersection が残りうる（走査順に依存する）ので、
 * 合成結果を構造的に（ref はたどらず）もう一度平坦化する。このとき、いま展開中の ref 名を引き継ぎ、
 * それを再び展開しようとする intersection（例: `Node.next = allOf[$ref Node]`）は無限展開になるため
 * 展開せず `intersection` のまま残し、その展開元の intersection も平坦化しない。
 */
export function flattenAllOf(ir: IRDocument, diagnostics: Diagnostics): void {
  const reported = new Set<string>();
  const report = (schema: Intersection, reason: string) => {
    if (schema.origin !== undefined) {
      if (reported.has(schema.origin)) return;
      reported.add(schema.origin);
    }
    diagnostics.info('allof-not-flattened', `allOf was not flattened: ${reason}.`, schema.origin);
  };

  const flattener = (expanding: ReadonlySet<string>, onCycle: () => void) => {
    const flatten = (schema: IRSchema): IRSchema => {
      if (schema.kind !== 'intersection') return schema;
      const refs = new Set<string>();
      const merged = merge(schema, ir, new Set(), refs);
      if (merged.status === 'unresolved') {
        report(schema, 'a $ref member could not be resolved (missing or cyclic)');
        return schema;
      }
      if (merged.status === 'mismatch') return schema;

      if ([...refs].some((name) => expanding.has(name))) {
        onCycle();
        report(schema, 'it expands a $ref that is already being expanded (self-referencing)');
        return schema;
      }
      let cyclic = false;
      const next = mapSchema(
        merged.schema,
        flattener(new Set([...expanding, ...refs]), () => {
          cyclic = true;
        }),
      );
      if (cyclic) {
        report(schema, 'its members contain a self-referencing allOf');
        return schema;
      }
      return next;
    };
    return flatten;
  };

  mapDocumentSchemas(ir, flattener(new Set(), () => {}));
}
