import type { IRMediaType, IROperation, IRParameter, IRResponse } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import { selectOperations as selectCsOperations } from '../csharp/services.js';
import type { Row } from './align.js';
import { doc, docRows, goSource, goString, writeKeyed, writeRows, type KeyedEntry } from './emit.js';
import type { GoPluginOptions } from './index.js';
import { fieldType, withDeprecation } from './models.js';
import { exported, goIdentifier, unexported, type GoNames } from './names.js';
import type { GoType, GoTypeResolver } from './types.js';

const PARAM_IN = { path: 'core.InPath', query: 'core.InQuery', header: 'core.InHeader', cookie: 'core.InCookie' } as const;
const STYLE = {
  simple: 'core.StyleSimple',
  label: 'core.StyleLabel',
  matrix: 'core.StyleMatrix',
  form: 'core.StyleForm',
  spaceDelimited: 'core.StyleSpaceDelimited',
  pipeDelimited: 'core.StylePipeDelimited',
  deepObject: 'core.StyleDeepObject',
} as const;
const BODY_KIND = { json: 'core.BodyJSON', form: 'core.BodyForm', multipart: 'core.BodyMultipart', text: 'core.BodyText', binary: 'core.BodyBinary' } as const;
const PARAM_METHOD = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie' } as const;

/** Members of the client that a service field must not take. */
export const CLIENT_MEMBERS: string[] = ['Core', 'Use'];

export type ServiceName = { group: string; typeName: string; field: string; snake: string };
export type OperationNames = { method: string; params: string | undefined; spec: string; errors: string };

/** Operations that pass the plugin's include / exclude (same rules as the C# plugin). */
export function selectOperations(ops: IROperation[], opts: GoPluginOptions): IROperation[] {
  return selectCsOperations(ops, { include: opts.include, exclude: opts.exclude } as Parameters<typeof selectCsOperations>[1]);
}

/** One service per group (`Default` without one): type `<Group>Service`, client field `<Group>`. */
export function buildServiceNames(ops: IROperation[]): Map<string, ServiceName> {
  const types = new UniqueNamer([], { caseInsensitive: true });
  const fields = new UniqueNamer(CLIENT_MEMBERS);
  const out = new Map<string, ServiceName>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    let field = exported(goIdentifier(group, 'PascalCase'));
    if (CLIENT_MEMBERS.includes(field)) field = `${field}Value`;
    const typeName = types.claim(`${field}Service`);
    out.set(group, { group, typeName, field: fields.claim(field), snake: toCase(typeName, 'snake_case') });
  }
  return out;
}

type Param = { ir: IRParameter; field: string; type: GoType };
type Body = { media: IRMediaType; type: GoType; required: boolean; runtime: boolean };

/** `<group>_service.go` for every group; returns the generated names per operation id. */
export function renderServices(
  ctx: PluginContext<GoPluginOptions>,
  ops: IROperation[],
  services: Map<string, ServiceName>,
  names: GoNames,
  resolver: GoTypeResolver,
  packageName: string,
  module: string,
): { files: { path: string; content: string }[]; operations: Map<string, OperationNames & ServiceName & { file: string }> } {
  const files: { path: string; content: string }[] = [];
  const operations = new Map<string, OperationNames & ServiceName & { file: string }>();
  for (const service of services.values()) {
    const file = names.claimFile(`${service.snake}`);
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const methods = new UniqueNamer();
    const w = ctx.writer({ indent: '\t' });
    const imports: string[] = [];
    w.line(
      members.some((op) => op.group === undefined)
        ? `// ${service.typeName} holds the operations without a group.`
        : `// ${service.typeName} holds the operations of the group ${goString(service.group)}.`,
    );
    w.block(`type ${service.typeName} struct {`, () => w.line('client *core.Client'));
    for (const op of members) {
      const n = operationNames(op, ctx.options, methods, names);
      operations.set(op.id, { ...n, ...service, file });
      w.blank();
      const body = renderOperation(ctx, w, op, n, service, names, resolver, imports);
      w.blank();
      renderSpec(w, op, n, body);
      w.blank();
      renderErrors(w, op, n, resolver);
    }
    files.push({ path: file, content: goSource(ctx, packageName, module, w.toString(), imports) });
  }
  return { files, operations };
}

function operationNames(op: IROperation, opts: GoPluginOptions, methods: UniqueNamer, names: GoNames): OperationNames {
  const rule = opts.naming.method ?? {};
  const base = opts.hooks.methodName?.(op) ?? goIdentifier(op.name, rule.case ?? 'PascalCase');
  const method = methods.claim(exported(applyTemplate(rule.name, base)));
  const local = unexported(method);
  return {
    method,
    params: op.parameters.length > 0 ? names.claim(`${method}Params`) : undefined,
    spec: names.claimLocal(`${local}Operation`),
    errors: names.claimLocal(`${local}Errors`),
  };
}

/** Writes the Params struct (if any) and the method; returns the operation's body, if any. */
function renderOperation(
  ctx: PluginContext<GoPluginOptions>,
  w: CodeWriter,
  op: IROperation,
  n: OperationNames,
  service: ServiceName,
  names: GoNames,
  resolver: GoTypeResolver,
  imports: string[],
): Body | undefined {
  const path = ['operations', op.id];
  const fieldNames = new UniqueNamer([], { caseInsensitive: true });
  const params: Param[] = op.parameters.map((p) => {
    const required = p.in === 'path' || p.required;
    const type = fieldType(resolver, p.schema, required, [...path, 'parameters', p.name]);
    imports.push(...(type.imports ?? []));
    return { ir: p, field: fieldNames.claim(exported(goIdentifier(p.name, 'PascalCase'))), type };
  });

  let body: Body | undefined;
  const content = op.requestBody?.contents[0];
  if (content && (op.method === 'get' || op.method === 'head')) {
    ctx.diagnostics.warn('request-body-ignored', `The request body of "${op.id}" is ignored: ${op.method.toUpperCase()} requests do not carry one.`);
  } else if (content) {
    const required = op.requestBody?.required === true;
    body = bodyType(content, required, resolver, [...path, 'requestBody', content.mediaType]);
    imports.push(...(body.type.imports ?? []));
  }

  if (n.params !== undefined) {
    w.line(`// ${n.params} are the parameters of ${service.typeName}.${n.method}.`);
    const rows: Row[] = [];
    for (const p of params) {
      rows.push(...docRows(withDeprecation(p.ir.description ?? p.ir.schema.description, p.ir.deprecated)));
      rows.push([p.field, p.type.code]);
    }
    w.block(`type ${n.params} struct {`, () => writeRows(w, rows));
    w.blank();
  }

  const success = successResponse(op.responses);
  const successContent = success?.contents[0];
  const decoder = successContent
    ? successDecoder(successContent, resolver, [...path, 'responses', String(success?.status), successContent.mediaType])
    : undefined;

  const args = ['ctx context.Context'];
  if (n.params !== undefined) args.push(`params ${n.params}`);
  if (body) args.push(`body ${body.type.code}`);
  args.push('opts ...core.RequestOption');
  const results = decoder ? `(${decoder.type}, *http.Response, error)` : '(*http.Response, error)';

  const summary = [op.summary, op.description].filter((s) => s !== undefined && s.trim() !== '').join('\n\n');
  doc(w, withDeprecation(`${n.method} sends ${op.method.toUpperCase()} ${op.path}.${summary === '' ? '' : `\n\n${summary}`}`, op.deprecated));
  w.block(`func (s *${service.typeName}) ${n.method}(${args.join(', ')}) ${results} {`, () => {
    const hasValues = params.length > 0 || body !== undefined;
    if (hasValues) w.line('values := core.NewValues()');
    for (const p of params) w.line(`values.${PARAM_METHOD[p.ir.in]}(${goString(p.ir.name)}, params.${p.field})`);
    if (body) {
      if (body.required) renderBody(w, body, names, resolver);
      else w.block('if body != nil {', () => renderBody(w, body as Body, names, resolver));
    }
    const call = `core.Do(ctx, s.client, ${n.spec}, ${hasValues ? 'values' : 'nil'}, ${decoder?.expression ?? 'core.DecodeNone'}, ${n.errors}, opts)`;
    if (decoder) {
      w.line(`return ${call}`);
    } else {
      w.line(`_, resp, err := ${call}`);
      w.line('return resp, err');
    }
  });
  return body;
}

/** The Go type of a request body: the schema's type, or the runtime body for non-object form / multipart schemas. */
function bodyType(media: IRMediaType, required: boolean, resolver: GoTypeResolver, path: string[]): Body {
  const wrap = (type: GoType): GoType => (!required || resolver.isNullable(media.schema) ? resolver.pointer(type) : type);
  if (media.kind === 'text') return { media, required, runtime: false, type: wrap({ code: 'string', friendly: 'String', nilable: false }) };
  if (media.kind === 'binary') return { media, required, runtime: false, type: wrap({ code: 'core.File', friendly: 'File', nilable: false }) };
  if ((media.kind === 'form' || media.kind === 'multipart') && resolver.objectTarget(media.schema) === undefined) {
    const code = media.kind === 'form' ? '*core.FormBody' : '*core.MultipartBody';
    return { media, required, runtime: true, type: { code, friendly: 'Body', nilable: true } };
  }
  return { media, required, runtime: false, type: fieldType(resolver, media.schema, required, path) };
}

function renderBody(w: CodeWriter, body: Body, names: GoNames, resolver: GoTypeResolver): void {
  const deref = body.type.code.startsWith('*') && !body.runtime ? '*body' : 'body';
  switch (body.media.kind) {
    case 'json':
      w.line('values.JSONBody(body)');
      return;
    case 'text':
      w.line(`values.TextBody(${deref})`);
      return;
    case 'binary':
      w.line(`values.BinaryBody(${deref})`);
      return;
    case 'form':
      w.line(body.runtime ? 'values.Body(body)' : 'values.FormBody(body)');
      return;
    case 'multipart': {
      if (body.runtime) {
        w.line('values.Body(body)');
        return;
      }
      const schemaName = resolver.objectTarget(body.media.schema) as string;
      const schema = resolver.schema(schemaName);
      const fields = names.fields(schemaName);
      w.line('mp := core.NewMultipart()');
      for (const p of schema?.kind === 'object' ? schema.properties : []) {
        const type = fieldType(resolver, p.schema, p.required, ['schemas', schemaName, 'properties', p.name]);
        const member = `body.${fields.get(p.name)}`;
        if (type.code === 'core.File') w.line(`mp.File(${goString(p.name)}, &${member})`);
        else if (type.code === '*core.File') w.line(`mp.File(${goString(p.name)}, ${member})`);
        else if (type.code === '[]core.File') w.line(`mp.Files(${goString(p.name)}, ${member})`);
        else w.line(`mp.Field(${goString(p.name)}, ${member})`);
      }
      w.line('values.Body(mp)');
    }
  }
}

function isSuccess(status: IRResponse['status']): boolean {
  return typeof status === 'number' ? status >= 200 && status < 300 : status === '2XX';
}

/** The lowest 2xx response (`2XX` only when no numeric one exists). */
function successResponse(responses: IRResponse[]): IRResponse | undefined {
  const numeric = responses
    .filter((r) => typeof r.status === 'number' && isSuccess(r.status))
    .sort((a, b) => (a.status as number) - (b.status as number));
  return numeric[0] ?? responses.find((r) => r.status === '2XX');
}

function successDecoder(media: IRMediaType, resolver: GoTypeResolver, path: string[]): { type: string; expression: string } {
  switch (media.kind) {
    case 'json': {
      const type = resolver.typeOf(media.schema, path);
      const code = type.model || (resolver.isNullable(media.schema) && !type.nilable) ? `*${type.code}` : type.code;
      return { type: code, expression: `core.DecodeJSON[${code}]` };
    }
    case 'binary':
      return { type: '[]byte', expression: 'core.DecodeBinary' };
    default:
      return { type: 'string', expression: 'core.DecodeText' };
  }
}

function responseKind(r: IRResponse): string {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return 'core.ResponseEmpty';
  return kind === 'json' ? 'core.ResponseJSON' : kind === 'binary' ? 'core.ResponseBinary' : 'core.ResponseText';
}

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames, body: Body | undefined): void {
  const scheme = (s: { name: string; scopes: string[] }) =>
    `{Name: ${goString(s.name)}${s.scopes.length > 0 ? `, Scopes: []string{${s.scopes.map(goString).join(', ')}}` : ''}}`;
  const param = (p: IRParameter) =>
    `{Name: ${goString(p.name)}, In: ${PARAM_IN[p.in]}, Style: ${STYLE[p.style]}${p.explode ? ', Explode: true' : ''}${p.allowReserved ? ', AllowReserved: true' : ''}}`;
  const entries: KeyedEntry[] = [
    { key: 'Name', value: goString(op.name) },
    { key: 'Method', value: goString(op.method.toUpperCase()) },
    { key: 'Path', value: goString(op.path) },
  ];
  if (op.tags.length > 0) entries.push({ key: 'Tags', value: `[]string{${op.tags.map(goString).join(', ')}}` });
  if (op.security.length > 0) {
    entries.push({ key: 'Security', open: '[]core.SecurityRequirement{', items: op.security.map((r) => `{${r.schemes.map(scheme).join(', ')}}`) });
  }
  if (op.parameters.length > 0) entries.push({ key: 'Params', open: '[]core.ParamSpec{', items: op.parameters.map(param) });
  if (body) {
    entries.push({ key: 'Body', value: BODY_KIND[body.media.kind] });
    entries.push({ key: 'MediaType', value: goString(body.media.mediaType) });
  }
  if (op.responses.length > 0) {
    entries.push({ key: 'Responses', value: `map[string]core.ResponseKind{${op.responses.map((r) => `${goString(String(r.status))}: ${responseKind(r)}`).join(', ')}}` });
  }
  w.block(`var ${n.spec} = &core.OperationSpec{`, () => writeKeyed(w, entries));
}

function renderErrors(w: CodeWriter, op: IROperation, n: OperationNames, resolver: GoTypeResolver): void {
  const rows: Row[] = op.responses.flatMap((r) => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    const status = `${goString(String(r.status))}:`;
    if (c.kind !== 'json') return [[status, 'core.TextError,']];
    const type = resolver.typeOf(c.schema, ['operations', op.id, 'responses', String(r.status), c.mediaType]);
    return [[status, `core.JSONError[${type.code}],`]];
  });
  if (rows.length === 0) {
    w.line(`var ${n.errors} core.ErrorDecoders`);
    return;
  }
  w.block(`var ${n.errors} = core.ErrorDecoders{`, () => writeRows(w, rows));
}

