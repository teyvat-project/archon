import { ArchonError, type Diagnostics } from '../diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../ir/types.js';
import { mapDocumentSchemas, mapSchema, type SchemaPath } from '../ir/walk.js';
import { escapePointer } from '../parser/schema.js';
import { applyTemplate } from '../writer/naming.js';

export type IncludeExclude = { include?: string[]; exclude?: string[] };

export type FiltersConfig = {
  operations?: IncludeExclude;
  tags?: IncludeExclude;
  schemas?: IncludeExclude;
  deprecated?: boolean;
  orphans?: boolean;
  preserveOrder?: boolean;
};

const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/s;

/**
 * `/…/flags` 形式なら RegExp として、それ以外は完全一致で照合する。
 * 正規表現として不正なら `invalid-filter-pattern` の ArchonError。
 */
export function matchesPattern(value: string, pattern: string): boolean {
  const m = REGEX_PATTERN.exec(pattern);
  if (!m) return value === pattern;
  let regex: RegExp;
  try {
    regex = new RegExp(m[1] as string, m[2]);
  } catch (e) {
    throw new ArchonError(
      'invalid-filter-pattern',
      `Invalid filter pattern ${pattern}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return regex.test(value);
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(value, p));
}

/** include が未指定（または空）なら全件通し、exclude に一致したものは常に落とす。 */
function passes(value: string, rule: IncludeExclude | undefined): boolean {
  if (!rule) return true;
  if (rule.exclude && matchesAny(value, rule.exclude)) return false;
  if (rule.include && rule.include.length > 0) return matchesAny(value, rule.include);
  return true;
}

function passesTags(tags: string[], rule: IncludeExclude | undefined): boolean {
  if (!rule) return true;
  if (rule.exclude && tags.some((t) => matchesAny(t, rule.exclude as string[]))) return false;
  if (rule.include && rule.include.length > 0) return tags.some((t) => matchesAny(t, rule.include as string[]));
  return true;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * operations（`op.id`）→ tags → schemas → deprecated の順にフィルタを適用し、
 * `preserveOrder` が `true` でなければ operations を id、schemas を名前でソートする。
 * `filters` が未指定でもソートは行う（既定の `preserveOrder: false`）。
 *
 * schema フィルタ / deprecated で除去した schema を指す ref（dangling ref）は、使用箇所の base meta
 * （nullable / description など）を残した `unknown` に置き換え、discriminator.mapping からは除去した
 * schema を指すエントリを落とす。置き換えごとに（schema 名, 位置）単位で 1 回 `filter-dangling-ref` を warn する。
 * orphan の除去は `removeOrphans` で別途行う（`filters.orphans` の判断は呼び出し側）。
 */
export function applyFilters(ir: IRDocument, filters: FiltersConfig | undefined, diagnostics: Diagnostics): void {
  const f = filters ?? {};

  ir.operations = ir.operations.filter(
    (op) => passes(op.id, f.operations) && passesTags(op.tags, f.tags) && !(f.deprecated === false && op.deprecated),
  );

  const removed = new Set<string>();
  for (const [name, schema] of [...ir.schemas]) {
    if (!passes(name, f.schemas) || (f.deprecated === false && schema.deprecated === true)) {
      ir.schemas.delete(name);
      removed.add(name);
    }
  }
  if (removed.size > 0) replaceDanglingRefs(ir, removed, diagnostics);

  if (f.preserveOrder !== true) {
    ir.operations.sort((a, b) => compare(a.id, b.id));
    const sorted = [...ir.schemas].sort(([a], [b]) => compare(a, b));
    ir.schemas.clear();
    for (const [name, schema] of sorted) ir.schemas.set(name, schema);
  }
}

/** 除去した schema への ref を `unknown` に置き換え、discriminator.mapping から除去した schema を落とす。 */
function replaceDanglingRefs(ir: IRDocument, removed: Set<string>, diagnostics: Diagnostics): void {
  const operationPointers = new Map(
    ir.operations.map((op) => [op.id, `#/paths/${escapePointer(op.path)}/${op.method}`] as const),
  );
  const rootPointer = (path: SchemaPath): string =>
    path[0] === 'schemas'
      ? `#/components/schemas/${escapePointer(path[1] ?? '')}`
      : (operationPointers.get(path[1] ?? '') ?? '#');

  const warned = new Set<string>();
  const warn = (name: string, location: string) => {
    const key = `${name}\0${location}`;
    if (warned.has(key)) return;
    warned.add(key);
    diagnostics.warn(
      'filter-dangling-ref',
      `Schema "${name}" was removed by the filters but is still referenced; the reference is typed as unknown`,
      location,
    );
  };

  mapDocumentSchemas(ir, (s, path) => {
    if (s.kind === 'ref' && removed.has(s.name)) {
      warn(s.name, s.origin ?? rootPointer(path));
      const { kind: _kind, name: _name, ...meta } = s;
      return { ...meta, kind: 'unknown' };
    }
    if (s.kind === 'union' && s.discriminator) {
      const dropped = [...s.discriminator.mapping.values()].filter((target) => removed.has(target));
      if (dropped.length === 0) return s;
      for (const target of dropped) warn(target, s.origin ?? rootPointer(path));
      const mapping = new Map([...s.discriminator.mapping].filter(([, target]) => !removed.has(target)));
      return { ...s, discriminator: { ...s.discriminator, mapping } };
    }
    return s;
  });
}

/** operation 配下の全 schema（parameters / requestBody / responses の headers と contents）。 */
function operationSchemas(op: IROperation): IRSchema[] {
  return [
    ...op.parameters.map((p) => p.schema),
    ...(op.requestBody?.contents.map((c) => c.schema) ?? []),
    ...op.responses.flatMap((r) => [...r.headers.values(), ...r.contents.map((c) => c.schema)]),
  ];
}

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

/** operation から（ref と discriminator.mapping を推移的に辿って）到達できない名前付き schema を削除する。 */
export function removeOrphans(ir: IRDocument): void {
  const reachable = new Set<string>();
  const queue: string[] = [];
  const enqueue = (names: Set<string>) => {
    for (const n of names) {
      if (!reachable.has(n)) {
        reachable.add(n);
        queue.push(n);
      }
    }
  };

  for (const op of ir.operations) for (const s of operationSchemas(op)) enqueue(referencedNames(s));
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const schema = ir.schemas.get(name);
    if (schema) enqueue(referencedNames(schema));
  }

  for (const name of [...ir.schemas.keys()]) if (!reachable.has(name)) ir.schemas.delete(name);
}

/**
 * 名前付き schema を `{{name}}` テンプレート（または関数）で改名し、全 `ref` と
 * discriminator.mapping の値を書き換える。既存名（改名済みを含む）と衝突する改名はスキップして
 * `schema-rename-conflict` を warn する。
 */
export function renameSchemas(
  ir: IRDocument,
  schemaName: string | ((name: string) => string) | undefined,
  diagnostics: Diagnostics,
): void {
  if (schemaName === undefined) return;

  const renames = new Map<string, string>();
  const taken = new Set(ir.schemas.keys());
  for (const name of ir.schemas.keys()) {
    const next = applyTemplate(schemaName, name);
    if (next === name) continue;
    if (taken.has(next)) {
      diagnostics.warn(
        'schema-rename-conflict',
        `Cannot rename schema "${name}" to "${next}": a schema with that name already exists. Keeping "${name}".`,
        `#/components/schemas/${name}`,
      );
      continue;
    }
    taken.add(next);
    renames.set(name, next);
  }
  if (renames.size === 0) return;

  const rewrite = (schema: IRSchema): IRSchema =>
    mapSchema(schema, (s) => {
      if (s.kind === 'ref') {
        const to = renames.get(s.name);
        return to === undefined ? s : { ...s, name: to };
      }
      if (s.kind === 'union' && s.discriminator) {
        const mapping = new Map([...s.discriminator.mapping].map(([k, v]) => [k, renames.get(v) ?? v]));
        return { ...s, discriminator: { ...s.discriminator, mapping } };
      }
      return s;
    });

  const entries = [...ir.schemas].map(([name, schema]) => [renames.get(name) ?? name, rewrite(schema)] as const);
  ir.schemas.clear();
  for (const [name, schema] of entries) ir.schemas.set(name, schema);

  for (const op of ir.operations) {
    for (const p of op.parameters) p.schema = rewrite(p.schema);
    for (const c of op.requestBody?.contents ?? []) c.schema = rewrite(c.schema);
    for (const r of op.responses) {
      for (const [h, schema] of r.headers) r.headers.set(h, rewrite(schema));
      for (const c of r.contents) c.schema = rewrite(c.schema);
    }
  }
}
