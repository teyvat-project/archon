import { ArchonError } from '../../diagnostics.js';
import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import type { PluginContext } from '../../plugin/types.js';
import { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import type { TypeScriptPluginOptions } from './index.js';
import { TS_RESERVED } from './reserved.js';

/** IR の schema 名 → 生成する TS 識別子。 */
export type TypeNameTable = Map<string /* IR schema name */, string /* TS identifier */>;

/**
 * named schema ごとに TS の型名を決める（`ir.schemas` の順、case-sensitive な UniqueNamer で衝突解決）。
 * `hooks.typeName` → `naming.type`（case → name テンプレート）の結果を識別子として正規化する
 * （不正文字は `_`、先頭が数字なら `_` を前置、予約語なら `_` を後置）。
 * `reserved` の名前（ランタイムや生成コードが同じスコープで使う名前）は使わない。
 */
export function buildTypeNameTable(
  ir: IRDocument,
  opts: TypeScriptPluginOptions,
  reserved: Iterable<string> = [],
): TypeNameTable {
  const namer = new UniqueNamer(reserved);
  const rule = opts.naming.type ?? {};
  const table: TypeNameTable = new Map();
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(rule.name, toCase(name, rule.case ?? 'PascalCase'));
    table.set(name, namer.claim(sanitizeIdentifier(base)));
  }
  return table;
}

/** 不正文字を `_` に置き換え、先頭が数字なら `_` を前置、予約語なら `_` を後置する。 */
export function sanitizeIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (id === '') id = '_';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (TS_RESERVED.has(id)) id = `${id}_`;
  return id;
}

/** `types.gen.ts` の内容を返す（先頭に生成ヘッダの行コメント、以降 named schema ごとの宣言）。 */
export function renderTypes(ctx: PluginContext<TypeScriptPluginOptions>, names: TypeNameTable): string {
  const { options: opts } = ctx;
  const w = ctx.writer();
  w.comment(ctx.headerLines('typescript'), 'line');
  for (const [schemaName, schema] of ctx.ir.schemas) {
    const name = typeName(names, schemaName);
    w.blank();
    w.comment(docLines(schema), 'jsdoc');
    if (schema.kind === 'enum' && opts.enums === 'const') {
      w.block(`export const ${name} = {`, () => {
        for (const m of enumMembers(schema.values)) w.line(`${m.name}: ${literal(m.value)},`);
      }, '} as const;');
      w.line(`export type ${name} = typeof ${name}[keyof typeof ${name}]${schema.nullable ? ' | null' : ''};`);
    } else if (schema.kind === 'enum' && opts.enums === 'enum' && !schema.nullable) {
      w.block(`export enum ${name} {`, () => {
        for (const m of enumMembers(schema.values)) w.line(`${m.name} = ${literal(m.value)},`);
      });
    } else {
      // enums==='enum' でも nullable な enum は TS の enum で表せないため、リテラル union にする
      w.line(`export type ${name} = ${schemaToTs(schema, names, opts, ['schemas', schemaName])};`);
    }
  }
  return w.toString();
}

/**
 * schema を TS の型式に変換する。object は複数行（2 スペースインデント）になる。
 * 優先順位: `hooks.typeOverride`（結果をそのまま使い、nullable は付けない）→
 * `typeMappings['kind:format']`（nullable なら `| null` を付ける）→ 既定の対応。
 */
export function schemaToTs(schema: IRSchema, names: TypeNameTable, opts: TypeScriptPluginOptions, path: SchemaPath): string {
  return render(schema, names, opts, path).text;
}

/** 型式の結合の強さ。配列要素などでは `Prec.Primary` 未満を括弧で囲む。 */
const enum Prec {
  Union = 0,
  Intersection = 1,
  Primary = 2,
}

type Rendered = { text: string; prec: Prec };

const SIMPLE_TYPE = /^[A-Za-z_$][A-Za-z0-9_$.]*(\[\])*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function render(schema: IRSchema, names: TypeNameTable, opts: TypeScriptPluginOptions, path: SchemaPath): Rendered {
  const override = opts.hooks.typeOverride?.(schema, { path });
  if (override !== undefined) return opaque(override);

  const format = 'format' in schema ? schema.format : undefined;
  const mapped = format === undefined ? undefined : opts.typeMappings[`${schema.kind}:${format}`];
  const base = mapped !== undefined ? opaque(mapped) : renderBase(schema, names, opts, path);
  if (!schema.nullable || base.text === 'null' || base.text === 'unknown') return base;
  return { text: `${base.text} | null`, prec: Prec.Union };
}

function renderBase(schema: IRSchema, names: TypeNameTable, opts: TypeScriptPluginOptions, path: SchemaPath): Rendered {
  const child = (s: IRSchema, ...segments: string[]) => render(s, names, opts, [...path, ...segments]);
  switch (schema.kind) {
    case 'string':
      return primary(opts.dates === 'Date' && (schema.format === 'date-time' || schema.format === 'date') ? 'Date' : 'string');
    case 'integer':
    case 'number':
      return primary('number');
    case 'boolean':
      return primary('boolean');
    case 'null':
      return primary('null');
    case 'binary':
      return primary('Blob');
    case 'unknown':
      return primary('unknown');
    case 'ref':
      return primary(typeName(names, schema.name));
    case 'const':
      return primary(isLiteral(schema.value) ? literal(schema.value) : 'unknown');
    case 'enum':
      return join(schema.values.map((v) => primary(literal(v))), ' | ', Prec.Union);
    case 'array':
      return primary(`${wrap(child(schema.items, 'items'), Prec.Primary)}[]`);
    case 'tuple': {
      const items = schema.items.map((s, i) => child(s, 'items', String(i)).text);
      if (schema.rest) items.push(`...${wrap(child(schema.rest, 'rest'), Prec.Primary)}[]`);
      return primary(`[${items.join(', ')}]`);
    }
    case 'union':
      return join(schema.variants.map((s, i) => child(s, 'variants', String(i))), ' | ', Prec.Union);
    case 'intersection':
      return join(schema.members.map((s, i) => child(s, 'members', String(i))), ' & ', Prec.Intersection);
    case 'object':
      return primary(renderObject(schema, child));
  }
}

function renderObject(
  schema: Extract<IRSchema, { kind: 'object' }>,
  child: (s: IRSchema, ...segments: string[]) => Rendered,
): string {
  const props = schema.properties.map((p) => ({ prop: p, type: child(p.schema, 'properties', p.name).text }));
  let index: string | undefined;
  if (schema.additionalProperties) {
    index = child(schema.additionalProperties, 'additionalProperties').text;
    // 全プロパティが必須かつ同じ型のときだけ index signature と両立する（optional は undefined を含むため不可）
    if (!props.every((p) => p.prop.required && p.type === index)) index = 'unknown';
  }

  if (props.length === 0) {
    if (index === undefined) return '{}';
    if (!index.includes('\n')) return `{ [key: string]: ${index} }`;
  }

  const w = new CodeWriter();
  w.block('{', () => {
    for (const { prop, type } of props) {
      w.comment(docLines(prop.schema), 'jsdoc');
      w.line(`${propertyKey(prop.name)}${prop.required ? '' : '?'}: ${type};`);
    }
    if (index !== undefined) w.line(`[key: string]: ${index};`);
  });
  return w.toString().trimEnd();
}

function join(parts: Rendered[], sep: string, prec: Prec): Rendered {
  if (parts.length === 0) return primary('never');
  if (parts.length === 1) return parts[0]!;
  return { text: parts.map((p) => wrap(p, prec + 1)).join(sep), prec };
}

function wrap(r: Rendered, min: Prec): string {
  return r.prec < min ? `(${r.text})` : r.text;
}

function primary(text: string): Rendered {
  return { text, prec: Prec.Primary };
}

/** ユーザー指定の型式。単純な型名以外は結合の強さが分からないので最弱として扱う。 */
function opaque(text: string): Rendered {
  return { text, prec: SIMPLE_TYPE.test(text) ? Prec.Primary : Prec.Union };
}

function typeName(names: TypeNameTable, schemaName: string): string {
  const name = names.get(schemaName);
  if (name === undefined) throw new ArchonError('unknown-schema', `Schema "${schemaName}" is not in the type name table.`);
  return name;
}

/** object リテラル / 型のキー。識別子として不正なら引用する。 */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : quote(name);
}

/** シングルクォートの文字列リテラル。 */
export function quote(value: string): string {
  return `'${JSON.stringify(value).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

function isLiteral(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function literal(value: string | number | boolean | null): string {
  return typeof value === 'string' ? quote(value) : String(value);
}

function docLines(schema: IRSchema): string[] {
  const lines = schema.description ? [schema.description] : [];
  if (schema.deprecated) lines.push('@deprecated');
  return lines;
}

/** enum メンバー名: 値の PascalCase（数値は `-` → `Minus`）、先頭が数字なら `_` を前置、空なら `Empty`。 */
function enumMembers(values: (string | number)[]): { name: string; value: string | number }[] {
  const namer = new UniqueNamer();
  return values.map((value) => {
    let base =
      typeof value === 'number'
        ? String(value).replace(/^-/, 'Minus').replace(/[^A-Za-z0-9]/g, '_')
        : toCase(value, 'PascalCase');
    if (base === '') base = 'Empty';
    if (/^[0-9]/.test(base)) base = `_${base}`;
    return { name: namer.claim(base), value };
  });
}
