import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument, IRSchema } from '../ir/types.js';
import { mapSchema } from '../ir/walk.js';
import { UniqueNamer, applyTemplate } from '../writer/naming.js';

export type ReadWriteOptions = false | { requests?: string; responses?: string };

type Side = 'request' | 'response';

const DEFAULT_REQUESTS = '{{name}}Writable';
const DEFAULT_RESPONSES = '{{name}}';

/** `ref` と discriminator.mapping の値（schema 名）を、ネスト含めて集める。 */
function referencedNames(schema: IRSchema): Set<string> {
  const names = new Set<string>();
  mapSchema(schema, (s) => {
    if (s.kind === 'ref') names.add(s.name);
    if (s.kind === 'union' && s.discriminator) {
      for (const target of s.discriminator.mapping.values()) names.add(target);
    }
    return s;
  });
  return names;
}

/** schema 自身を除く、ネストした位置に readOnly / writeOnly があるか。 */
function hasOwnReadWriteMarker(schema: IRSchema): boolean {
  let found = false;
  mapSchema(schema, (s, path) => {
    if (path.length > 0 && (s.readOnly === true || s.writeOnly === true)) found = true;
    return s;
  });
  return found;
}

/**
 * 分割が必要な named schema（自身が readOnly / writeOnly を含む、または分割が必要な schema を
 * ref / discriminator.mapping で参照する）を、名前グラフ上の不動点として求める。循環でも終了する。
 */
function findSplitSchemas(ir: IRDocument): Set<string> {
  const needs = new Set<string>();
  const deps = new Map<string, Set<string>>();
  for (const [name, schema] of ir.schemas) {
    if (hasOwnReadWriteMarker(schema)) needs.add(name);
    deps.set(name, referencedNames(schema));
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, refs] of deps) {
      if (needs.has(name)) continue;
      for (const target of refs) {
        if (needs.has(target)) {
          needs.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  return needs;
}

/** `ref` と discriminator.mapping の値を `names` に従って書き換え、`side` に応じて反対側専用のプロパティを除く。 */
function project(schema: IRSchema, names: ReadonlyMap<string, string>, strip: 'readOnly' | 'writeOnly' | undefined): IRSchema {
  return mapSchema(schema, (s) => {
    switch (s.kind) {
      case 'ref': {
        const to = names.get(s.name);
        return to === undefined ? s : { ...s, name: to };
      }
      case 'union': {
        if (!s.discriminator) return s;
        const mapping = new Map([...s.discriminator.mapping].map(([k, v]) => [k, names.get(v) ?? v]));
        return { ...s, discriminator: { ...s.discriminator, mapping } };
      }
      case 'object':
        return strip === undefined ? s : { ...s, properties: s.properties.filter((p) => p.schema[strip] !== true) };
      default:
        return s;
    }
  });
}

/**
 * `readOnly` / `writeOnly` を（推移的に）含む named schema を、request 用（readOnly を除く）と
 * response 用（writeOnly を除く）に分割する。request 側（parameters / requestBody）の参照は request 用の名前に、
 * response 側（response の headers / contents）の参照は response 用の名前に書き換える。
 * discriminator.mapping の値（schema 名）も同様に書き換える。
 *
 * 分割対象の schema は到達箇所にかかわらず常に 2 つの variant を作る（未使用の variant は
 * `removeOrphans` で落とせる）。テンプレート結果が既存の別 schema 名と衝突したら
 * 数値接尾辞を付けて `readwrite-name-conflict` を warn する。
 */
export function splitReadWrite(ir: IRDocument, opts: ReadWriteOptions, diagnostics: Diagnostics): void {
  if (opts === false) return;
  const split = findSplitSchemas(ir);
  if (split.size === 0) return;

  const requestTemplate = opts.requests ?? DEFAULT_REQUESTS;
  const responseTemplate = opts.responses ?? DEFAULT_RESPONSES;

  const namer = new UniqueNamer(ir.schemas.keys());
  const requestNames = new Map<string, string>();
  const responseNames = new Map<string, string>();
  const assign = (map: Map<string, string>, template: string, name: string, taken: Set<string>): void => {
    const wanted = applyTemplate(template, name);
    // 元の名前をそのまま使う variant は in place で置き換える（reserve 済みなので claim しない）
    const final = wanted === name && !taken.has(name) ? name : namer.claim(wanted);
    if (final !== wanted) {
      diagnostics.warn(
        'readwrite-name-conflict',
        `Cannot name the ${map === requestNames ? 'request' : 'response'} variant of schema "${name}" "${wanted}": a schema with that name already exists. Using "${final}".`,
        `#/components/schemas/${name}`,
      );
    }
    taken.add(final);
    map.set(name, final);
  };
  for (const name of split) {
    const taken = new Set<string>();
    assign(responseNames, responseTemplate, name, taken);
    assign(requestNames, requestTemplate, name, taken);
  }

  const next = new Map<string, IRSchema>();
  for (const [name, schema] of ir.schemas) {
    if (!split.has(name)) {
      next.set(name, schema);
      continue;
    }
    // 他の schema の variant 名で上書きしないよう、元の位置に応答側 → 要求側の順で入れる
    next.set(responseNames.get(name) as string, project(schema, responseNames, 'writeOnly'));
    next.set(requestNames.get(name) as string, project(schema, requestNames, 'readOnly'));
  }
  // 分割対象でない schema は split schema を参照しない（参照していれば分割対象になっている）
  ir.schemas.clear();
  for (const [name, schema] of next) ir.schemas.set(name, schema);

  for (const op of ir.operations) {
    const request = (s: IRSchema) => project(s, requestNames, undefined);
    const response = (s: IRSchema) => project(s, responseNames, undefined);
    for (const p of op.parameters) p.schema = request(p.schema);
    for (const c of op.requestBody?.contents ?? []) c.schema = request(c.schema);
    for (const r of op.responses) {
      for (const [h, schema] of r.headers) r.headers.set(h, response(schema));
      for (const c of r.contents) c.schema = response(c.schema);
    }
  }
}
