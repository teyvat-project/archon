import type { IRDocument, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import type { TypeScriptPluginOptions } from './index.js';
import { quote, type TypeNameTable } from './types.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `dates: 'Date'` 用の変換関数の計画。date / date-time の string を（ref を辿って推移的に）含む
 * named schema だけが `named` に入る（schema 名 → 関数名 `transform<TypeName>`）。
 */
export interface TransformerPlan {
  named: Map<string, string>;
  /** schema（ref を辿って）に変換対象が含まれるか。 */
  needs(schema: IRSchema): boolean;
}

/** 操作の成功レスポンス用など、named schema 以外に追加で生成する変換関数。 */
export type ExtraTransformer = { name: string; schema: IRSchema };

export function planTransformers(ir: IRDocument, names: TypeNameTable, opts: TypeScriptPluginOptions): TransformerPlan {
  const isDate = (s: IRSchema) => isDateString(s, opts);
  const needing = new Set<string>();
  const directlyNeeds = (schema: IRSchema): boolean =>
    some(schema, (s) => isDate(s) || (s.kind === 'ref' && needing.has(s.name)));

  // 不動点まで繰り返す（循環参照があっても集合が増えなくなれば止まる）
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, schema] of ir.schemas) {
      if (!needing.has(name) && directlyNeeds(schema)) {
        needing.add(name);
        changed = true;
      }
    }
  }

  const named = new Map<string, string>();
  for (const name of ir.schemas.keys()) {
    if (needing.has(name)) named.set(name, `transform${names.get(name) ?? name}`);
  }
  return { named, needs: directlyNeeds };
}

/**
 * `transformers.gen.ts` の内容。各関数は JSON.parse 直後の値をその場で書き換えて返す
 * （値の形を確認してから変換するので、想定外の形の値はそのまま残る）。
 */
export function renderTransformers(
  ctx: PluginContext<TypeScriptPluginOptions>,
  plan: TransformerPlan,
  extras: ExtraTransformer[],
): string {
  const opts = ctx.options;
  const w = ctx.writer();
  w.comment(ctx.headerLines('typescript'), 'line');
  const functions: { name: string; schema: IRSchema }[] = [
    ...[...plan.named].map(([schemaName, name]) => ({ name, schema: ctx.ir.schemas.get(schemaName) as IRSchema })),
    ...extras,
  ];
  if (functions.length === 0) {
    w.blank();
    w.line('export {};');
    return w.toString();
  }

  w.blank();
  w.line('const isObject = (value: unknown): value is { [key: string]: any } =>');
  w.line("  typeof value === 'object' && value !== null && !Array.isArray(value);");
  const emitter = new Emitter(w, plan, opts);
  for (const { name, schema } of functions) {
    w.blank();
    w.block(`export function ${name}(data: any): any {`, () => {
      emitter.emit(schema, 'data', false, 0);
      w.line('return data;');
    });
  }
  return w.toString();
}

class Emitter {
  constructor(
    private readonly w: CodeWriter,
    private readonly plan: TransformerPlan,
    private readonly opts: TypeScriptPluginOptions,
  ) {}

  /**
   * `target`（代入可能な式）を変換する文を出力する。
   * `mayBeAbsent` は object のプロパティのように、存在しないキーへ代入してはいけない位置を表す。
   */
  emit(schema: IRSchema, target: string, mayBeAbsent: boolean, depth: number): void {
    const { w, plan } = this;
    if (!plan.needs(schema)) return;
    switch (schema.kind) {
      case 'string':
        w.line(`if (typeof ${target} === 'string') ${target} = new Date(${target});`);
        return;
      case 'ref': {
        const fn = plan.named.get(schema.name) as string;
        w.line(mayBeAbsent ? `if (${target} !== undefined) ${target} = ${fn}(${target});` : `${target} = ${fn}(${target});`);
        return;
      }
      case 'array': {
        const i = `i${depth}`;
        w.block(`if (Array.isArray(${target})) {`, () => {
          w.block(`for (let ${i} = 0; ${i} < ${target}.length; ${i}++) {`, () => {
            this.emit(schema.items, `${target}[${i}]`, false, depth + 1);
          });
        });
        return;
      }
      case 'tuple': {
        const rest = schema.rest;
        w.block(`if (Array.isArray(${target})) {`, () => {
          schema.items.forEach((item, index) => this.emit(item, `${target}[${index}]`, true, depth));
          if (rest && plan.needs(rest)) {
            const i = `i${depth}`;
            w.block(`for (let ${i} = ${schema.items.length}; ${i} < ${target}.length; ${i}++) {`, () => {
              this.emit(rest, `${target}[${i}]`, false, depth + 1);
            });
          }
        });
        return;
      }
      case 'object': {
        const extra = schema.additionalProperties;
        w.block(`if (isObject(${target})) {`, () => {
          for (const p of schema.properties) this.emit(p.schema, access(target, p.name), true, depth);
          if (extra && plan.needs(extra)) {
            const k = `k${depth}`;
            w.block(`for (const ${k} of Object.keys(${target})) {`, () => {
              if (schema.properties.length > 0) {
                w.line(`if (${schema.properties.map((p) => `${k} === ${quote(p.name)}`).join(' || ')}) continue;`);
              }
              this.emit(extra, `${target}[${k}]`, false, depth + 1);
            });
          }
        });
        return;
      }
      case 'union':
        for (const variant of schema.variants) {
          if (!plan.needs(variant)) continue;
          const tags = discriminatorValues(schema, variant);
          if (tags.length === 0) {
            this.emit(variant, target, mayBeAbsent, depth);
            continue;
          }
          const property = access(target, (schema.discriminator as { property: string }).property);
          const check = tags.map((t) => `${property} === ${quote(t)}`).join(' || ');
          w.block(`if (isObject(${target}) && ${tags.length > 1 ? `(${check})` : check}) {`, () => {
            this.emit(variant, target, false, depth);
          });
        }
        return;
      case 'intersection':
        for (const member of schema.members) this.emit(member, target, mayBeAbsent, depth);
        return;
      default:
        return;
    }
  }
}

/** 判別あり union の ref バリアントに対応する discriminator の値（mapping に無ければ空）。 */
function discriminatorValues(union: Extract<IRSchema, { kind: 'union' }>, variant: IRSchema): string[] {
  if (!union.discriminator || variant.kind !== 'ref') return [];
  return [...union.discriminator.mapping].filter(([, target]) => target === variant.name).map(([value]) => value);
}

function access(target: string, name: string): string {
  return IDENTIFIER.test(name) ? `${target}.${name}` : `${target}[${quote(name)}]`;
}

function isDateString(schema: IRSchema, opts: TypeScriptPluginOptions): boolean {
  return (
    schema.kind === 'string' &&
    (schema.format === 'date-time' || schema.format === 'date') &&
    // typeMappings で別の型にした場合は変換しない
    opts.typeMappings[`string:${schema.format}`] === undefined
  );
}

/** schema（ref は辿らない）のいずれかのノードが `pred` を満たすか。 */
function some(schema: IRSchema, pred: (s: IRSchema) => boolean): boolean {
  if (pred(schema)) return true;
  switch (schema.kind) {
    case 'array':
      return some(schema.items, pred);
    case 'tuple':
      return schema.items.some((s) => some(s, pred)) || (schema.rest !== undefined && some(schema.rest, pred));
    case 'object':
      return (
        schema.properties.some((p) => some(p.schema, pred)) ||
        (schema.additionalProperties !== undefined &&
          schema.additionalProperties !== false &&
          some(schema.additionalProperties, pred))
      );
    case 'union':
      return schema.variants.some((s) => some(s, pred));
    case 'intersection':
      return schema.members.some((s) => some(s, pred));
    default:
      return false;
  }
}
