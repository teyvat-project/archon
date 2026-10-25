import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument, IRProperty, IRSchema } from '../ir/types.js';
import { mapDocumentSchemas, mapSchema } from '../ir/walk.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type Intersection = Extract<IRSchema, { kind: 'intersection' }>;

/**
 * `object`: 合成済み、`mismatch`: object でないメンバーがある、`unresolved`: ref が解決できない / 循環している。
 * `via` は合成結果の各プロパティ（と additionalProperties）が、どの ref をたどって取り込まれたかを表す。
 * 取り込み元の ref 名は、そのプロパティの内側を再平坦化するときの祖先になる。
 */
type Resolved =
  | { status: 'object'; schema: ObjectSchema; via: Map<string, ReadonlySet<string>>; additionalVia: ReadonlySet<string> }
  | { status: 'mismatch' }
  | { status: 'unresolved' };

const MISMATCH: Resolved = { status: 'mismatch' };
const UNRESOLVED: Resolved = { status: 'unresolved' };
const NONE: ReadonlySet<string> = new Set();

/**
 * member を object として解決する。`ref` は named schema をたどり（`visiting` で循環を検出）、
 * 名前付き intersection もその場で合成する。`refs` には合成で展開した全 ref 名を集める。
 */
function resolveObject(
  schema: IRSchema,
  ir: IRDocument,
  visiting: ReadonlySet<string>,
  refs: Set<string>,
): Resolved {
  switch (schema.kind) {
    case 'object':
      return {
        status: 'object',
        schema,
        via: new Map(schema.properties.map((p) => [p.name, NONE])),
        additionalVia: NONE,
      };
    case 'ref': {
      if (visiting.has(schema.name)) return UNRESOLVED;
      refs.add(schema.name);
      const target = ir.schemas.get(schema.name);
      if (!target) return UNRESOLVED;
      const resolved = resolveObject(target, ir, new Set(visiting).add(schema.name), refs);
      if (resolved.status !== 'object') return resolved;
      const add = (v: ReadonlySet<string>) => new Set(v).add(schema.name);
      return {
        ...resolved,
        via: new Map([...resolved.via].map(([name, v]) => [name, add(v)])),
        additionalVia: add(resolved.additionalVia),
      };
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
  const via = new Map<string, ReadonlySet<string>>();
  let additionalProperties: ObjectSchema['additionalProperties'];
  let additionalVia = NONE;
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
      via.set(p.name, resolved.via.get(p.name) ?? NONE);
    }
    if (resolved.schema.additionalProperties !== undefined) {
      additionalProperties = resolved.schema.additionalProperties;
      additionalVia = resolved.additionalVia;
    }
  }
  if (mismatch) return MISMATCH;

  const object: ObjectSchema =
    additionalProperties === undefined
      ? { ...own, kind: 'object', properties: [...properties.values()] }
      : { ...own, kind: 'object', properties: [...properties.values()], additionalProperties };
  return { status: 'object', schema: object, via, additionalVia };
}

/**
 * 全メンバーが object（または object に解決できる ref）の `intersection` を、プロパティを合成した
 * `object` に置き換える。object 以外が含まれる場合はそのまま残す。ref が解決できない / 循環する場合も
 * 残した上で `allof-not-flattened` を info に記録する（同じ `origin` は 1 回だけ）。
 *
 * 合成で取り込んだ ref 先のプロパティには未平坦化の intersection が残りうる（走査順に依存する）ので、
 * 合成結果を構造的に（ref はたどらず）もう一度平坦化する。祖先（展開中の ref 名）はパスごとに追跡する:
 * 各プロパティの内側は「親の祖先 + そのプロパティを取り込んだ ref」を祖先として平坦化する。祖先を
 * 再び展開しようとする intersection（例: `Node.next = allOf[$ref Node]`）は無限展開になるため展開せず
 * `intersection` のまま残し、その展開元の intersection も平坦化しない。同じ ref を別経路で展開するだけの
 * ダイヤモンド（`Child = allOf[$ref Common, {p: allOf[$ref Common]}]`）は循環ではないので平坦化する。
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

  const flattener = (ancestors: ReadonlySet<string>, onCycle: () => void) => {
    const flatten = (schema: IRSchema): IRSchema => {
      if (schema.kind !== 'intersection') return schema;
      const refs = new Set<string>();
      const merged = merge(schema, ir, new Set(), refs);
      if (merged.status === 'unresolved') {
        report(schema, 'a $ref member could not be resolved (missing or cyclic)');
        return schema;
      }
      if (merged.status === 'mismatch') return schema;

      if ([...refs].some((name) => ancestors.has(name))) {
        onCycle();
        report(schema, 'it expands a $ref that is already being expanded (self-referencing)');
        return schema;
      }
      let cyclic = false;
      const inner = (v: ReadonlySet<string>) =>
        flattener(new Set([...ancestors, ...v]), () => {
          cyclic = true;
        });
      const { properties, additionalProperties } = merged.schema;
      const next: ObjectSchema = {
        ...merged.schema,
        properties: properties.map((p) => ({ ...p, schema: mapSchema(p.schema, inner(merged.via.get(p.name) ?? NONE)) })),
      };
      if (additionalProperties) {
        next.additionalProperties = mapSchema(additionalProperties, inner(merged.additionalVia));
      }
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
