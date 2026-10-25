import type { IRDocument, IRSchema } from '../ir/types.js';
import { mapDocumentSchemas } from '../ir/walk.js';

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;

/** variant を（ref をたどって）非 nullable の object に解決する。解決できなければ undefined。 */
function resolveObject(schema: IRSchema, ir: IRDocument, seen: Set<string> = new Set()): ObjectSchema | undefined {
  if (schema.nullable) return undefined;
  if (schema.kind === 'object') return schema;
  if (schema.kind !== 'ref' || seen.has(schema.name)) return undefined;
  seen.add(schema.name);
  const target = ir.schemas.get(schema.name);
  return target && resolveObject(target, ir, seen);
}

/** `const`（string）または単一値の string `enum` ならその値を返す。 */
export function tagValue(schema: IRSchema): string | undefined {
  if (schema.nullable) return undefined;
  if (schema.kind === 'const') return typeof schema.value === 'string' ? schema.value : undefined;
  if (schema.kind === 'enum' && schema.base === 'string' && schema.values.length === 1) {
    const [value] = schema.values;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function infer(
  variants: IRSchema[],
  ir: IRDocument,
): { property: string; mapping: Map<string, string> } | undefined {
  if (variants.length < 2) return undefined;
  const objects: ObjectSchema[] = [];
  for (const v of variants) {
    const o = resolveObject(v, ir);
    if (!o) return undefined;
    objects.push(o);
  }

  const [first] = objects;
  for (const candidate of first?.properties ?? []) {
    const mapping = new Map<string, string>();
    const ok = objects.every((o, i) => {
      const p = o.properties.find((x) => x.name === candidate.name);
      const value = p?.required ? tagValue(p.schema) : undefined;
      if (value === undefined || mapping.has(value)) return false;
      const variant = variants[i] as IRSchema;
      mapping.set(value, variant.kind === 'ref' ? variant.name : '');
      return true;
    });
    if (ok) return { property: candidate.name, mapping };
  }
  return undefined;
}

/**
 * `discriminator` を持たない `union` について、全バリアントが object（ref 解決後）で、
 * 全バリアントの required な string `const` / 単一値 `enum` プロパティの値が互いに異なる場合に
 * `discriminator` を設定する。mapping の値は ref なら ref 名、inline object なら `''`
 * （hoist 後に名前が入る）。nullable なバリアントを含む union は対象外。
 */
export function inferDiscriminators(ir: IRDocument): void {
  mapDocumentSchemas(ir, (schema) => {
    if (schema.kind !== 'union' || schema.discriminator) return schema;
    const discriminator = infer(schema.variants, ir);
    return discriminator ? { ...schema, discriminator } : schema;
  });
}
