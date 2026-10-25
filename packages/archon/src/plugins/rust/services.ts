import type { IRMediaType, IROperation, IRParameter, IRResponse, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import { selectOperations as selectCsOperations } from '../csharp/services.js';
import { doc, literal, rsWriter } from './emit.js';
import type { RustPluginOptions } from './index.js';
import { bare, escapeKeyword, moduleIdentifier, rsIdentifier, sanitize, type RsNames } from './names.js';
import { RESERVED_MODULES } from './reserved.js';
import { API_FILE, type RsType, type RsTypeResolver } from './types.js';

const PARAM_IN = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie' } as const;
const STYLE = {
  simple: 'Simple',
  label: 'Label',
  matrix: 'Matrix',
  form: 'Form',
  spaceDelimited: 'SpaceDelimited',
  pipeDelimited: 'PipeDelimited',
  deepObject: 'DeepObject',
} as const;
const BODY_KIND = { json: 'Json', form: 'Form', multipart: 'Multipart', text: 'Text', binary: 'Binary' } as const;
const METHODS: Record<IROperation['method'], string> = {
  get: 'GET',
  put: 'PUT',
  post: 'POST',
  delete: 'DELETE',
  options: 'OPTIONS',
  head: 'HEAD',
  patch: 'PATCH',
  trace: 'TRACE',
};

/** Methods of the client struct that a service accessor must not take. */
export const CLIENT_MEMBERS: string[] = ['new', 'builder', 'from_options', 'core', 'use_middleware', 'default', 'clone', 'fmt'];
/** Builder methods and fields an operation's parameters must not take. */
const BUILDER_MEMBERS = ['core', 'options', 'send', 'request_options', 'into_future', 'clone', 'fmt'];

export type ServiceName = { group: string; module: string; struct: string; accessor: string };
export type OperationNames = { method: string; builder: string; error: string | undefined; spec: string };

/** Operations that pass the plugin's include / exclude (same rules as the C# plugin). */
export function selectOperations(ops: IROperation[], opts: RustPluginOptions): IROperation[] {
  return selectCsOperations(ops, { include: opts.include, exclude: opts.exclude } as Parameters<typeof selectCsOperations>[1]);
}

/** One service per group (`Default` without one): module `services::<group>`, struct `<Group>Service`, accessor `<group>()`. */
export function buildServiceNames(ops: IROperation[]): Map<string, ServiceName> {
  const modules = new UniqueNamer(RESERVED_MODULES, { caseInsensitive: true });
  const structs = new UniqueNamer([], { caseInsensitive: true });
  const accessors = new UniqueNamer(CLIENT_MEMBERS);
  const out = new Map<string, ServiceName>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    const snake = rsIdentifier(group, 'snake_case');
    out.set(group, {
      group,
      module: modules.claim(moduleIdentifier(snake)),
      struct: structs.claim(`${rsIdentifier(group, 'PascalCase')}Service`),
      accessor: escapeKeyword(accessors.claim(CLIENT_MEMBERS.includes(snake) ? `${snake}_api` : snake)),
    });
  }
  return out;
}

type Param = { ir: IRParameter; name: string; type: RsType; required: boolean; nullable: boolean };
type Body = { media: IRMediaType; name: string; type: RsType; required: boolean; nullable: boolean; raw: boolean };
type ErrorVariant = { name: string; status: IRResponse['status']; type: string; json: boolean; description?: string };

/** `src/services/<group>.rs` for every group and `src/services/mod.rs`; returns the generated names per operation id. */
export function renderServices(
  ctx: PluginContext<RustPluginOptions>,
  ops: IROperation[],
  services: Map<string, ServiceName>,
  names: RsNames,
  resolver: RsTypeResolver,
): { files: { path: string; content: string }[]; operations: Map<string, OperationNames & ServiceName> } {
  const files: { path: string; content: string }[] = [];
  const operations = new Map<string, OperationNames & ServiceName>();
  for (const service of services.values()) {
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const methods = new UniqueNamer(['new', 'core', 'clone', 'fmt']);
    const types = new UniqueNamer(['core', 'models', service.struct, 'Self', 'Box', 'Option', 'Result', 'String', 'Vec', 'Some', 'None', 'Ok', 'Err']);
    const statics = new UniqueNamer();
    const prepared = members.map((op) => {
      const n = operationNames(op, ctx.options, methods, types, statics);
      operations.set(op.id, { ...n, ...service });
      return { op, n, call: prepareCall(ctx, op, resolver) };
    });

    const body = ctx.writer({ indent: '    ' });
    body.line(`/// The operations of the \`${service.group.replace(/`/g, '')}\` group.`);
    body.line('#[derive(Debug, Clone)]');
    body.block(`pub struct ${service.struct} {`, () => body.line('core: std::sync::Arc<core::ApiClientCore>,'));
    body.blank();
    body.block(`impl ${service.struct} {`, () => {
      body.block('pub(crate) fn new(core: std::sync::Arc<core::ApiClientCore>) -> Self {', () => body.line('Self { core }'));
      for (const { op, n, call } of prepared) {
        body.blank();
        renderMethod(body, op, n, call);
      }
    });
    for (const { op, n, call } of prepared) {
      body.blank();
      renderBuilder(body, op, n, call, names, resolver);
      if (n.error) {
        body.blank();
        renderErrorEnum(body, op, n.error, call.errors);
      }
      body.blank();
      renderSpec(body, op, n, call.body);
    }

    const text = body.toString();
    const w = rsWriter(ctx);
    w.line('use crate::core;');
    if (/\bmodels::/.test(text)) w.line('use crate::models;');
    w.blank();
    w.line(text.replace(/\n$/, ''));
    files.push({ path: `src/services/${service.module}.rs`, content: w.toString() });
  }

  const w = rsWriter(ctx);
  w.line('//! The operations of the API, one service per group.');
  const list = [...services.values()];
  if (list.length > 0) w.blank();
  for (const s of list) w.line(`pub mod ${s.module};`);
  if (list.length > 0) w.blank();
  for (const s of list) w.line(`pub use self::${s.module}::${s.struct};`);
  files.push({ path: 'src/services/mod.rs', content: w.toString() });
  return { files, operations };
}

function operationNames(op: IROperation, opts: RustPluginOptions, methods: UniqueNamer, types: UniqueNamer, statics: UniqueNamer): OperationNames {
  const rule = opts.naming.method ?? {};
  const base = sanitize(opts.hooks.methodName?.(op) ?? rsIdentifier(op.name, rule.case ?? 'snake_case'));
  const method = escapeKeyword(methods.claim(sanitize(applyTemplate(rule.name, base))));
  const pascal = rsIdentifier(op.name, 'PascalCase');
  const hasErrors = op.responses.some((r) => !isSuccess(r.status) && r.contents.length > 0);
  return {
    method,
    builder: types.claim(`${pascal}Request`),
    error: hasErrors ? types.claim(`${pascal}Error`) : undefined,
    spec: statics.claim(sanitize(toCase(bare(method), 'SCREAMING_SNAKE_CASE')) || 'OPERATION'),
  };
}

type Call = {
  params: Param[];
  body: Body | undefined;
  positional: (Param | Body)[];
  optional: (Param | Body)[];
  dataType: string;
  decoder: string;
  errors: ErrorVariant[];
};

function prepareCall(ctx: PluginContext<RustPluginOptions>, op: IROperation, resolver: RsTypeResolver): Call {
  const path = ['operations', op.id];
  const argNames = new UniqueNamer(BUILDER_MEMBERS);
  const params: Param[] = op.parameters.map((p) => {
    const required = p.in === 'path' || p.required;
    return {
      ir: p,
      name: escapeKeyword(argNames.claim(rsIdentifier(p.name, 'snake_case'))),
      type: resolver.typeOf(p.schema, [...path, 'parameters', p.name], 'models::'),
      required,
      nullable: resolver.isNullable(p.schema),
    };
  });

  let body: Body | undefined;
  const content = op.requestBody?.contents[0];
  if (content && (op.method === 'get' || op.method === 'head')) {
    ctx.diagnostics.warn('request-body-ignored', `The request body of "${op.id}" is ignored: ${op.method.toUpperCase()} requests do not carry one.`);
  } else if (content) {
    const { type, raw } = bodyType(content, resolver, [...path, 'requestBody', content.mediaType]);
    const nullable = resolver.isNullable(content.schema);
    // Only a JSON body can be sent as `null`; other kinds treat a nullable body as optional.
    const required = op.requestBody?.required === true && (!nullable || content.kind === 'json');
    body = { media: content, name: escapeKeyword(argNames.claim('body')), type, required, nullable: nullable && content.kind === 'json', raw };
  }

  const positional = [
    ...params.filter((p) => p.ir.in === 'path'),
    ...(body?.required ? [body] : []),
    ...params.filter((p) => p.ir.in !== 'path' && p.required),
  ];
  const optional = [...(body && !body.required ? [body] : []), ...params.filter((p) => !p.required)];

  const success = successResponse(op.responses);
  const successContent = success?.contents[0];
  let dataType = '()';
  let decoder = 'core::decode_empty';
  if (successContent?.kind === 'json') {
    dataType = resolver.usage(successContent.schema, [...path, 'responses', String(success?.status), successContent.mediaType], 'models::').code;
    decoder = 'core::decode_json';
  } else if (successContent?.kind === 'binary') {
    dataType = 'Vec<u8>';
    decoder = 'core::decode_binary';
  } else if (successContent) {
    dataType = 'String';
    decoder = 'core::decode_text';
  }

  const variantNames = new UniqueNamer(['Self']);
  const errors = op.responses.flatMap((r): ErrorVariant[] => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    const status = String(r.status);
    const name = variantNames.claim(status === 'default' ? 'Default' : `Status${status.toLowerCase()}`);
    const json = c.kind === 'json';
    const type = json ? resolver.usage(c.schema, [...path, 'responses', status, c.mediaType], 'models::').code : 'String';
    return [{ name, status: r.status, type, json, ...(r.description !== undefined && { description: r.description }) }];
  });

  return { params, body, positional, optional, dataType, decoder, errors };
}

/** The Rust type of a request body: the schema's type, or the runtime body for non-object form / multipart schemas. */
function bodyType(media: IRMediaType, resolver: RsTypeResolver, path: string[]): { type: RsType; raw: boolean } {
  if (media.kind === 'text') return { type: { code: 'String', friendly: 'String', defaultable: true }, raw: false };
  if (media.kind === 'binary') return { type: API_FILE, raw: false };
  if ((media.kind === 'form' || media.kind === 'multipart') && objectSchemaName(media.schema, resolver) === undefined) {
    const runtime = media.kind === 'form' ? 'core::FormBody' : 'core::MultipartBody';
    return { type: { code: runtime, friendly: runtime, defaultable: true }, raw: true };
  }
  return { type: resolver.typeOf(media.schema, path, 'models::'), raw: false };
}

/** The named object schema a body refers to (hoisting turns inline objects into refs). */
function objectSchemaName(schema: IRSchema, resolver: RsTypeResolver): string | undefined {
  return schema.kind === 'ref' && resolver.declares(schema.name) && resolver.schema(schema.name)?.kind === 'object' ? schema.name : undefined;
}

function isBody(arg: Param | Body): arg is Body {
  return 'media' in arg;
}

/** The type a builder field holds. */
function fieldType(arg: Param | Body): string {
  const inner = arg.nullable ? `Option<${arg.type.code}>` : arg.type.code;
  return arg.required ? inner : `Option<${arg.type.code}>`;
}

function description(arg: Param | Body): string | undefined {
  if (isBody(arg)) return undefined;
  return arg.ir.description ?? arg.ir.schema.description;
}

function operationDoc(op: IROperation): string {
  return [op.summary, op.description].filter((s) => s !== undefined && s !== '').join('\n\n');
}

function renderMethod(w: CodeWriter, op: IROperation, n: OperationNames, call: Call): void {
  const lines = [operationDoc(op)];
  const params = call.positional.flatMap((a) => {
    const d = description(a);
    return d ? [`- \`${bare(a.name)}\`: ${d.replace(/\s*\n\s*/g, ' ')}`] : [];
  });
  if (params.length > 0) lines.push(params.join('\n'));
  doc(w, lines.filter((l) => l !== '').join('\n\n'));
  if (op.deprecated) w.line('#[deprecated]');
  const args = ['&self', ...call.positional.map((a) => `${a.name}: impl Into<${fieldType(a)}>`)];
  w.block(`pub fn ${n.method}(${args.join(', ')}) -> ${n.builder} {`, () => {
    w.block(`${n.builder} {`, () => {
      w.line('core: self.core.clone(),');
      for (const a of call.positional) w.line(`${a.name}: ${a.name}.into(),`);
      for (const a of call.optional) w.line(`${a.name}: None,`);
      w.line('options: core::RequestOptions::default(),');
    });
  });
}

function returnType(n: OperationNames, call: Call): string {
  return `Result<core::ApiResponse<${call.dataType}>, core::Error${n.error ? `<${n.error}>` : ''}>`;
}

function renderBuilder(w: CodeWriter, op: IROperation, n: OperationNames, call: Call, names: RsNames, resolver: RsTypeResolver): void {
  w.line(`/// A call of \`${op.name.replace(/`/g, '')}\`: set optional parameters, then \`.await\` it (or call [\`Self::send\`]).`);
  w.line('#[must_use = "a request does nothing until it is awaited"]');
  w.line('#[derive(Debug, Clone)]');
  w.block(`pub struct ${n.builder} {`, () => {
    w.line('core: std::sync::Arc<core::ApiClientCore>,');
    for (const a of [...call.positional, ...call.optional]) w.line(`${a.name}: ${fieldType(a)},`);
    w.line('options: core::RequestOptions,');
  });
  w.blank();
  w.block(`impl ${n.builder} {`, () => {
    for (const a of call.optional) {
      doc(w, description(a) ?? (isBody(a) ? 'The request body.' : undefined));
      w.block(`pub fn ${a.name}(mut self, value: impl Into<${a.type.code}>) -> Self {`, () => {
        w.line(`self.${a.name} = Some(value.into());`);
        w.line('self');
      });
      w.blank();
    }
    w.line('/// Per-call settings: extra headers, middleware extensions, another base URL.');
    w.block('pub fn request_options(mut self, options: core::RequestOptions) -> Self {', () => {
      w.line('self.options = options;');
      w.line('self');
    });
    w.blank();
    w.line('/// Sends the request.');
    w.block(`pub async fn send(self) -> ${returnType(n, call)} {`, () => {
      const chain = call.params.map((p) => `.${p.ir.in}(${literal(p.ir.name)}, &self.${p.name})`);
      const body = call.body;
      if (body?.required) chain.push(bodyCall(body, `self.${body.name}`, names, resolver));
      const optionalBody = body !== undefined && !body.required;
      const head = `let ${optionalBody ? 'mut ' : ''}values = core::RequestValues::new()`;
      if (chain.length === 0) {
        w.line(`${head};`);
      } else {
        w.line(head);
        w.indent(() => chain.forEach((c, i) => w.line(i === chain.length - 1 ? `${c};` : c)));
      }
      if (body && optionalBody) {
        w.block(`if let Some(body) = self.${body.name} {`, () => w.line(`values = values${bodyCall(body, 'body', names, resolver)};`));
      }
      w.line(`self.core.send(&${n.spec}, values, ${call.decoder}, self.options).await`);
    });
  });
  w.blank();
  w.block(`impl std::future::IntoFuture for ${n.builder} {`, () => {
    w.line(`type Output = ${returnType(n, call)};`);
    w.line("type IntoFuture = core::BoxFuture<'static, Self::Output>;");
    w.blank();
    w.block('fn into_future(self) -> Self::IntoFuture {', () => w.line('Box::pin(self.send())'));
  });
}

/** The `RequestValues` call setting the body held in `src` (a field of `self`, or a local). */
function bodyCall(body: Body, src: string, names: RsNames, resolver: RsTypeResolver): string {
  switch (body.media.kind) {
    case 'json':
      return `.json_body(&${src})`;
    case 'text':
      return `.text_body(${src})`;
    case 'binary':
      return `.binary_body(${src})`;
    case 'form':
      return body.raw ? `.form(${src})` : `.form_body(&${src})`;
    case 'multipart': {
      const schemaName = objectSchemaName(body.media.schema, resolver);
      if (body.raw || schemaName === undefined) return `.multipart(${src})`;
      const schema = resolver.schema(schemaName);
      const members = names.members(schemaName);
      const parts = (schema?.kind === 'object' ? schema.properties : []).map((p) => {
        const member = `${src}.${members.get(p.name)}`;
        const code = resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name], 'models::').code;
        const optional = !p.required || resolver.isNullable(p.schema);
        if (code === API_FILE.code) return `.add_file(${literal(p.name)}, ${optional ? `${member}.as_ref()` : `&${member}`})`;
        if (code === `Vec<${API_FILE.code}>`) return `.add_files(${literal(p.name)}, ${optional ? `${member}.iter().flatten()` : `&${member}`})`;
        return `.add_json(${literal(p.name)}, &${member})`;
      });
      return `.multipart(\n    core::MultipartBody::new()\n${parts.map((p) => `        ${p}`).join('\n')},\n)`;
    }
  }
}

function renderErrorEnum(w: CodeWriter, op: IROperation, name: string, errors: ErrorVariant[]): void {
  w.line(`/// The error bodies of \`${op.name.replace(/`/g, '')}\`, by status (in [\`core::ApiError::body\`]).`);
  w.line('#[derive(Debug, Clone, PartialEq)]');
  w.block(`pub enum ${name} {`, () => {
    for (const e of errors) {
      doc(w, e.description);
      w.line(`${e.name}(${e.type}),`);
    }
  });
  w.blank();
  const decode = (e: ErrorVariant) => (e.json ? `core::decode_error_json(body).map(Self::${e.name})` : `Some(Self::${e.name}(core::decode_error_text(body)))`);
  const exact = errors.filter((e) => typeof e.status === 'number');
  const ranges = errors.filter((e) => typeof e.status === 'string' && /^[1-5]XX$/i.test(e.status));
  const fallback = errors.find((e) => e.status === 'default');
  w.block(`impl core::ErrorBody for ${name} {`, () => {
    if (exact.length === 0 && ranges.length === 0 && fallback) {
      w.block('fn decode(_status: u16, body: &[u8]) -> Option<Self> {', () => w.line(decode(fallback)));
      return;
    }
    w.block('fn decode(status: u16, body: &[u8]) -> Option<Self> {', () => {
      w.block('match status {', () => {
        for (const e of exact) w.line(`${e.status} => ${decode(e)},`);
        for (const e of ranges) {
          const hundred = Number(String(e.status)[0]) * 100;
          w.line(`${hundred}..=${hundred + 99} => ${decode(e)},`);
        }
        w.line(`_ => ${fallback ? decode(fallback) : 'None'},`);
      });
    });
  });
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

function responseKind(r: IRResponse): string {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return 'Empty';
  return kind === 'json' ? 'Json' : kind === 'binary' ? 'Binary' : 'Text';
}

function slice(items: string[]): string {
  return `&[${items.join(', ')}]`;
}

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames, body: Body | undefined): void {
  const security = op.security.map(
    (r) => `core::SecurityRequirement { schemes: ${slice(r.schemes.map((s) => `core::SecurityScheme { name: ${literal(s.name)}, scopes: ${slice(s.scopes.map(literal))} }`))} }`,
  );
  const params = op.parameters.map(
    (p) =>
      `core::ParamSpec { name: ${literal(p.name)}, location: core::ParamLocation::${PARAM_IN[p.in]}, style: core::ParamStyle::${STYLE[p.style]}, explode: ${p.explode}, allow_reserved: ${p.allowReserved} }`,
  );
  const responses = op.responses.map((r) => `(${literal(String(r.status))}, core::ResponseKind::${responseKind(r)})`);
  const field = (name: string, items: string[]) => {
    if (items.length === 0) {
      w.line(`${name}: &[],`);
      return;
    }
    w.block(`${name}: &[`, () => items.forEach((i) => w.line(`${i},`)), '],');
  };
  w.block(`static ${n.spec}: core::OperationSpec = core::OperationSpec {`, () => {
    w.line(`operation_name: ${literal(op.name)},`);
    w.line(`method: core::Method::${METHODS[op.method]},`);
    w.line(`path: ${literal(op.path)},`);
    w.line(`tags: ${slice(op.tags.map(literal))},`);
    field('security', security);
    field('params', params);
    w.line(`body: ${body ? `Some(core::BodyKind::${BODY_KIND[body.media.kind]})` : 'None'},`);
    w.line(`body_media_type: ${body ? `Some(${literal(body.media.mediaType)})` : 'None'},`);
    w.line(`responses: ${slice(responses)},`);
  }, '};');
}
