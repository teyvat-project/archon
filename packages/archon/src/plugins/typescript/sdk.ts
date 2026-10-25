import type { IRMediaType, IROperation, IRParameter, IRResponse, IRSchema } from '../../ir/types.js';
import { collectRefs } from '../../ir/walk.js';
import { matchesPattern } from '../../passes/filters.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import type { TypeScriptPluginOptions } from './index.js';
import type { ExtraTransformer, TransformerPlan } from './transformers.js';
import { propertyKey, quote, sanitizeIdentifier, schemaToTs, type TypeNameTable } from './types.js';

/** sdk.gen.ts が固定で export する名前。 */
export const SDK_EXPORTS = ['Options'] as const;

export type OperationNames = {
  /** 関数（class スタイルでは static メンバー）の識別子。 */
  method: string;
  /** class スタイルのときの所属クラス。 */
  className?: string;
  dataType: string;
  responsesType: string;
  responseType: string;
  errorsType: string;
  errorType: string;
  specName: string;
};

type OperationModel = {
  op: IROperation;
  names: OperationNames;
  /** 採用する requestBody（GET / HEAD では送らないので無し）。 */
  body?: IRMediaType;
  /** Data に必須のメンバー（path、必須の query / header / cookie、必須の body）があるか。 */
  required: boolean;
  /** spec の `transform` に入れる関数名。 */
  transform?: string;
};

export type SdkModel = {
  operations: OperationModel[];
  /** transformers.gen.ts に追加で生成する、操作のレスポンス用の変換関数。 */
  extraTransformers: ExtraTransformer[];
};

/**
 * プラグインの include / exclude（`op.id` に対する `matchesPattern`、exclude 優先）を通った操作について、
 * 生成する識別子と spec の構成を決める。名前は `reserved`（型名・ランタイムや他の生成ファイルの export）と
 * 衝突しないよう UniqueNamer で決める。
 */
export function buildSdkModel(
  ctx: PluginContext<TypeScriptPluginOptions>,
  reserved: Iterable<string>,
  plan: TransformerPlan | undefined,
): SdkModel {
  const opts = ctx.options;
  const namer = new UniqueNamer(reserved);
  const rule = opts.naming.method ?? {};
  const classNames = new Map<string, string>();

  const operations = selectOperations(ctx.ir.operations, opts).map((op): OperationModel => {
    const base = opts.hooks.methodName?.(op) ?? applyTemplate(rule.name, toCase(op.name, rule.case ?? 'camelCase'));
    const method = namer.claim(sanitizeIdentifier(base));
    const pascal = sanitizeIdentifier(toCase(method, 'PascalCase') || 'Operation');
    const names: OperationNames = {
      method,
      dataType: namer.claim(`${pascal}Data`),
      responsesType: namer.claim(`${pascal}Responses`),
      responseType: namer.claim(`${pascal}Response`),
      errorsType: namer.claim(`${pascal}Errors`),
      errorType: namer.claim(`${pascal}Error`),
      specName: namer.claim(`${method}Spec`),
    };
    if (opts.sdk.style === 'class') {
      const group = op.group ?? 'Default';
      let className = classNames.get(group);
      if (className === undefined) {
        className = namer.claim(sanitizeIdentifier(toCase(group, 'PascalCase') || 'Default'));
        classNames.set(group, className);
      }
      names.className = className;
    }

    const content = op.requestBody?.contents[0];
    let body: IRMediaType | undefined = content;
    if (content && (op.method === 'get' || op.method === 'head')) {
      body = undefined;
      ctx.diagnostics.warn(
        'request-body-ignored',
        `The request body of "${op.id}" is ignored: fetch cannot send a body with ${op.method.toUpperCase()}.`,
      );
    }
    const required =
      (body !== undefined && op.requestBody?.required === true) || op.parameters.some(isRequiredParam);
    return { op, names, required, ...(body && { body }) };
  });

  // 変換関数の名前は操作の名前が決まった後で取る（操作名を奪わないように）
  const extraTransformers: ExtraTransformer[] = [];
  if (plan) {
    for (const model of operations) {
      const schemas = successSchemas(model.op).filter((s) => plan.needs(s));
      const first = schemas[0];
      if (first === undefined) continue;
      if (schemas.length === 1 && first.kind === 'ref') {
        model.transform = plan.named.get(first.name) as string;
        continue;
      }
      const name = namer.claim(`transform${model.names.responseType}`);
      const schema: IRSchema = schemas.length === 1 ? first : { kind: 'union', variants: schemas, nullable: false };
      extraTransformers.push({ name, schema });
      model.transform = name;
    }
  }
  return { operations, extraTransformers };
}

function selectOperations(ops: IROperation[], opts: TypeScriptPluginOptions): IROperation[] {
  const matches = (op: IROperation, patterns: string[] | undefined) => patterns?.some((p) => matchesPattern(op.id, p));
  return ops.filter((op) => {
    if (matches(op, opts.exclude)) return false;
    return opts.include === undefined || opts.include.length === 0 || matches(op, opts.include) === true;
  });
}

/** 2xx の JSON レスポンスの schema（同じ ref は 1 つにまとめる）。 */
function successSchemas(op: IROperation): IRSchema[] {
  const seen = new Set<string>();
  const out: IRSchema[] = [];
  for (const r of op.responses) {
    const c = r.contents[0];
    if (!isSuccess(r.status) || c?.kind !== 'json') continue;
    if (c.schema.kind === 'ref') {
      if (seen.has(c.schema.name)) continue;
      seen.add(c.schema.name);
    }
    out.push(c.schema);
  }
  return out;
}

function isSuccess(status: IRResponse['status']): boolean {
  return typeof status === 'number' ? status >= 200 && status < 300 : status === '2XX';
}

/** `sdk.gen.ts` の内容。 */
export function renderSdk(
  ctx: PluginContext<TypeScriptPluginOptions>,
  model: SdkModel,
  names: TypeNameTable,
): string {
  const opts = ctx.options;
  const ext = opts.importExtension;
  const typeOf = (schema: IRSchema, path: string[]) => schemaToTs(schema, names, opts, path);
  const ops = model.operations;

  const w = ctx.writer();
  w.comment(ctx.headerLines('typescript'), 'line');
  w.blank();
  if (ops.length > 0) w.line(`import { client } from './client.gen${ext}';`);
  w.line(`import type { ${ops.length > 0 ? 'Client, OperationSpec' : 'Client'} } from './core/index${ext}';`);
  const transforms = [...new Set(ops.flatMap((m) => (m.transform ? [m.transform] : [])))].sort();
  if (transforms.length > 0) w.line(`import { ${transforms.join(', ')} } from './transformers.gen${ext}';`);
  const types = referencedTypes(model, names);
  if (types.length > 0) w.line(`import type { ${types.join(', ')} } from './types.gen${ext}';`);

  w.blank();
  w.block('export type Options<TData, ThrowOnError extends boolean = boolean> = TData & {', () => {
    w.line('client?: Client<any>;');
    w.line('signal?: AbortSignal;');
    w.line('throwOnError?: ThrowOnError;');
    w.line('extensions?: { [key: string]: unknown };');
    w.line('baseUrl?: string;');
  }, '};');

  for (const m of ops) {
    renderData(w, m, typeOf);
    renderStatusTypes(w, m, typeOf, true);
    renderStatusTypes(w, m, typeOf, false);
    renderSpec(w, m);
    if (opts.sdk.style === 'functions') {
      w.blank();
      w.comment(operationDoc(m.op), 'jsdoc');
      renderFunction(w, `export const ${m.names.method}`, m);
    }
  }

  if (opts.sdk.style === 'class') {
    const classes = new Map<string, OperationModel[]>();
    for (const m of ops) {
      const className = m.names.className as string;
      classes.set(className, [...(classes.get(className) ?? []), m]);
    }
    for (const [className, members] of classes) {
      w.blank();
      w.block(`export class ${className} {`, () => {
        members.forEach((m, i) => {
          if (i > 0) w.blank();
          w.comment(operationDoc(m.op), 'jsdoc');
          renderFunction(w, `static ${m.names.method}`, m);
        });
      });
    }
  }
  return w.toString();
}

type TypeOf = (schema: IRSchema, path: string[]) => string;

function renderFunction(w: CodeWriter, head: string, m: OperationModel): void {
  const n = m.names;
  const options = `options: Options<${n.dataType}, ThrowOnError>${m.required ? '' : ' = {}'}`;
  w.line(`${head} = <ThrowOnError extends boolean = false>(${options}) =>`);
  w.line(`  (options.client ?? client).request<${n.responseType}, ${n.errorType}, ThrowOnError>(${n.specName}, options);`);
}

const PARAM_SECTIONS = [
  { key: 'path', in: 'path' },
  { key: 'query', in: 'query' },
  { key: 'headers', in: 'header' },
  { key: 'cookies', in: 'cookie' },
] as const;

/** path パラメータは常に必須として扱う。 */
function isRequiredParam(p: IRParameter): boolean {
  return p.in === 'path' || p.required;
}

/** `<Op>Data` を出力する。キーはパラメータの元の名前。query / headers / cookies は必須パラメータを含むときだけ必須。 */
function renderData(w: CodeWriter, m: OperationModel, typeOf: TypeOf): void {
  const { op, names: n, body } = m;
  const sections = PARAM_SECTIONS.map((s) => ({ ...s, params: op.parameters.filter((p) => p.in === s.in) })).filter(
    (s) => s.params.length > 0,
  );
  const bodyRequired = body !== undefined && op.requestBody?.required === true;

  w.blank();
  if (sections.length === 0 && body === undefined) {
    w.line(`export type ${n.dataType} = {};`);
    return;
  }
  w.block(`export type ${n.dataType} = {`, () => {
    for (const s of sections) {
      w.block(`${s.key}${s.params.some(isRequiredParam) ? '' : '?'}: {`, () => {
        for (const p of s.params) {
          w.comment(paramDoc(p), 'jsdoc');
          const type = typeOf(p.schema, ['operations', op.id, 'parameters', p.name]);
          w.line(`${propertyKey(p.name)}${isRequiredParam(p) ? '' : '?'}: ${type};`);
        }
      }, '};');
    }
    if (body) {
      const type = typeOf(body.schema, ['operations', op.id, 'requestBody', body.mediaType]);
      w.line(`body${bodyRequired ? '' : '?'}: ${type};`);
    }
  }, '};');
}

/** `<Op>Responses` / `<Op>Response`（success）または `<Op>Errors` / `<Op>Error` を出力する。 */
function renderStatusTypes(w: CodeWriter, m: OperationModel, typeOf: TypeOf, success: boolean): void {
  const { op, names: n } = m;
  const mapName = success ? n.responsesType : n.errorsType;
  const unionName = success ? n.responseType : n.errorType;
  const responses = op.responses.filter((r) => isSuccess(r.status) === success);

  w.blank();
  if (responses.length === 0) {
    w.line(`export type ${mapName} = {};`);
  } else {
    w.block(`export type ${mapName} = {`, () => {
      for (const r of responses) {
        const c = r.contents[0];
        const type = c
          ? typeOf(c.schema, ['operations', op.id, 'responses', String(r.status), c.mediaType])
          : success
            ? 'void'
            : 'unknown';
        w.line(`${statusKey(r.status)}: ${type};`);
      }
    }, '};');
  }
  w.blank();
  w.line(`export type ${unionName} = ${responses.length === 0 ? 'unknown' : `${mapName}[keyof ${mapName}]`};`);
}

function renderSpec(w: CodeWriter, m: OperationModel): void {
  const { op, body } = m;
  const security = op.security
    .map((r) => `[${r.schemes.map((s) => `{ scheme: ${quote(s.name)}, scopes: [${s.scopes.map(quote).join(', ')}] }`).join(', ')}]`)
    .join(', ');
  const responses = op.responses.map((r) => `${propertyKey(String(r.status))}: '${responseKind(r)}'`);

  w.blank();
  w.block(`const ${m.names.specName}: OperationSpec = {`, () => {
    w.line(`operationName: ${quote(op.name)},`);
    w.line(`method: '${op.method.toUpperCase()}',`);
    w.line(`path: ${quote(op.path)},`);
    w.line(`tags: [${op.tags.map(quote).join(', ')}],`);
    w.line(`security: [${security}],`);
    if (op.parameters.length === 0) {
      w.line('params: [],');
    } else {
      w.block('params: [', () => {
        for (const p of op.parameters) {
          const reserved = p.allowReserved ? ', allowReserved: true' : '';
          w.line(`{ name: ${quote(p.name)}, in: '${p.in}', style: '${p.style}', explode: ${p.explode}${reserved} },`);
        }
      }, '],');
    }
    if (body) w.line(`body: { kind: '${body.kind}', mediaType: ${quote(body.mediaType)} },`);
    w.line(responses.length === 0 ? 'responses: {},' : `responses: { ${responses.join(', ')} },`);
    if (m.transform) w.line(`transform: ${m.transform},`);
  }, '};');
}

/** json / text / binary はそのまま、form / multipart のレスポンスは text、content が無ければ empty。 */
function responseKind(r: IRResponse): 'json' | 'text' | 'binary' | 'empty' {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return 'empty';
  return kind === 'form' || kind === 'multipart' ? 'text' : kind;
}

function statusKey(status: IRResponse['status']): string {
  return typeof status === 'number' ? String(status) : propertyKey(status);
}

/** sdk.gen.ts が型として参照する named schema の TS 名（ソート済み）。 */
function referencedTypes(model: SdkModel, names: TypeNameTable): string[] {
  const refs = new Set<string>();
  const add = (schema: IRSchema) => {
    for (const name of collectRefs(schema)) refs.add(name);
  };
  for (const { op, body } of model.operations) {
    for (const p of op.parameters) add(p.schema);
    if (body) add(body.schema);
    for (const r of op.responses) {
      const c = r.contents[0];
      if (c) add(c.schema);
    }
  }
  return [...refs].flatMap((name) => {
    const tsName = names.get(name);
    return tsName === undefined ? [] : [tsName];
  }).sort();
}

function operationDoc(op: IROperation): string[] {
  const lines: string[] = [];
  if (op.summary) lines.push(op.summary);
  if (op.summary && op.description) lines.push('');
  if (op.description) lines.push(op.description);
  if (op.deprecated) lines.push('@deprecated');
  return lines;
}

function paramDoc(p: IRParameter): string[] {
  const lines = p.schema.description ? [p.schema.description] : [];
  if (p.deprecated) lines.push('@deprecated');
  return lines;
}
