import type { IRDocument, IROperation, IRSchema, IRSchemaBase } from '../ir/types.js';
import type { SchemaPath } from '../ir/walk.js';
import { UniqueNamer, toCase } from '../writer/naming.js';
import { tagValue } from './discriminator.js';

export type HoistOptions = {
  objects: boolean;
  enums: boolean;
  nameHook?: (path: SchemaPath, ctx: { suggested: string }) => string | undefined;
};

type ObjectSchema = Extract<IRSchema, { kind: 'object' }>;
type UnionSchema = Extract<IRSchema, { kind: 'union' }>;

/** 使用箇所（ref 側）に残すメタ。 */
const USAGE_META = ['description', 'deprecated', 'readOnly', 'writeOnly', 'default', 'origin'] as const;

const pascal = (s: string) => toCase(s, 'PascalCase');
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function usageRef(schema: IRSchema, name: string): IRSchema {
  const out: IRSchemaBase & { kind: 'ref'; name: string } = { kind: 'ref', name, nullable: schema.nullable };
  for (const key of USAGE_META) {
    if (schema[key] !== undefined) Object.assign(out, { [key]: schema[key] });
  }
  return out;
}

/** 巻き上げ先の schema。使用箇所に属するメタ（nullable / default / readOnly / writeOnly）を外す。 */
function namedSchema(schema: IRSchema): IRSchema {
  const out: IRSchema = { ...schema, nullable: false };
  delete out.default;
  delete out.readOnly;
  delete out.writeOnly;
  return out;
}

function tagOf(object: ObjectSchema, property: string): string | undefined {
  const p = object.properties.find((x) => x.name === property);
  return p ? tagValue(p.schema) : undefined;
}

/**
 * inline の object（プロパティを 1 つ以上持つもの）/ enum を named schema に移し、`ref` に置き換える。
 * union のバリアント object も対象で、判別あり union の `mapping` の `''` は巻き上げ後の名前で埋める。
 *
 * named schemas（宣言順）→ operations（順）を処理し、巻き上げた schema は `ir.schemas` の末尾に
 * 親 → 子の順で追加する。トップレベルの named schema 自体は巻き上げない。
 */
export function hoistInlineSchemas(ir: IRDocument, opts: HoistOptions): void {
  if (!opts.objects && !opts.enums) return;
  const namer = new UniqueNamer(ir.schemas.keys());

  const shouldHoist = (s: IRSchema): boolean =>
    (opts.objects && s.kind === 'object' && s.properties.length > 0) || (opts.enums && s.kind === 'enum');

  /** `name` はこの位置の提案名（hoist されなければ子の命名の親名としてそのまま使う）。 */
  function walk(schema: IRSchema, path: SchemaPath, name: string): IRSchema {
    if (!shouldHoist(schema)) return children(schema, path, name);

    const finalName = namer.claim(opts.nameHook?.(path, { suggested: name }) ?? name);
    // 親を先に登録して、子より前の位置を確保する
    ir.schemas.set(finalName, schema);
    ir.schemas.set(finalName, namedSchema(children(schema, path, finalName)));
    return usageRef(schema, finalName);
  }

  /** `schema` 自体は巻き上げず、直接の子だけを処理する。 */
  function children(schema: IRSchema, path: SchemaPath, name: string): IRSchema {
    const at = (child: IRSchema, segments: string[], childName: string) =>
      walk(child, [...path, ...segments], childName);

    switch (schema.kind) {
      case 'array':
        return { ...schema, items: at(schema.items, ['items'], `${name}Item`) };
      case 'tuple': {
        const items = schema.items.map((s, i) => at(s, ['items', String(i)], `${name}Item${i + 1}`));
        return schema.rest ? { ...schema, items, rest: at(schema.rest, ['rest'], `${name}Rest`) } : { ...schema, items };
      }
      case 'object': {
        const properties = schema.properties.map((p) => ({
          ...p,
          schema: at(p.schema, ['properties', p.name], `${name}${pascal(p.name)}`),
        }));
        const { additionalProperties } = schema;
        return additionalProperties
          ? {
              ...schema,
              properties,
              additionalProperties: at(additionalProperties, ['additionalProperties'], `${name}Value`),
            }
          : { ...schema, properties };
      }
      case 'union':
        return unionChildren(schema, path, name);
      case 'intersection':
        return {
          ...schema,
          members: schema.members.map((s, i) => at(s, ['members', String(i)], `${name}Member${i + 1}`)),
        };
      default:
        return schema;
    }
  }

  function unionChildren(schema: UnionSchema, path: SchemaPath, name: string): IRSchema {
    const { discriminator } = schema;
    const mapping = discriminator ? new Map(discriminator.mapping) : undefined;

    const variants = schema.variants.map((variant, i) => {
      // 判別値は、プロパティが巻き上げられる前の variant から読む
      const tag = discriminator && variant.kind === 'object' ? tagOf(variant, discriminator.property) : undefined;
      const suffix = tag !== undefined && pascal(tag) !== '' ? pascal(tag) : `Variant${i + 1}`;
      const next = walk(variant, [...path, 'variants', String(i)], `${name}${suffix}`);
      if (mapping && tag !== undefined && next.kind === 'ref' && variant.kind !== 'ref' && mapping.get(tag) === '') {
        mapping.set(tag, next.name);
      }
      return next;
    });

    return discriminator && mapping
      ? { ...schema, variants, discriminator: { ...discriminator, mapping } }
      : { ...schema, variants };
  }

  function hoistOperation(op: IROperation): void {
    const base = ['operations', op.id];
    const opName = pascal(op.name);

    for (const p of op.parameters) {
      p.schema = walk(p.schema, [...base, 'parameters', p.name], `${opName}${pascal(p.name)}`);
    }
    for (const c of op.requestBody?.contents ?? []) {
      c.schema = walk(c.schema, [...base, 'requestBody', c.mediaType], `${opName}Body`);
    }
    for (const r of op.responses) {
      const status = upperFirst(String(r.status));
      const rbase = [...base, 'responses', String(r.status)];
      for (const [headerName, schema] of r.headers) {
        r.headers.set(
          headerName,
          walk(schema, [...rbase, 'headers', headerName], `${opName}Response${status}${pascal(headerName)}`),
        );
      }
      for (const c of r.contents) {
        c.schema = walk(c.schema, [...rbase, c.mediaType], `${opName}Response${status}`);
      }
    }
  }

  // named schemas（宣言順）。巻き上げで追加される分は処理済みなのでスナップショットを使う。
  for (const [name, schema] of [...ir.schemas]) {
    ir.schemas.set(name, children(schema, ['schemas', name], name));
  }
  for (const op of ir.operations) hoistOperation(op);
}
