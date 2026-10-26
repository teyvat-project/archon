import type { IRMediaType, IROperation, IRParameter, IRResponse } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import { selectOperations as selectCsOperations } from '../csharp/services.js';
import { docLines, rbFile, rbString, writeList } from './emit.js';
import type { RubyPluginOptions } from './index.js';
import { withDeprecation, withDeprecationNote, withEnumNote } from './models.js';
import { constant, rubyIdentifier, screaming, type RubyNames } from './names.js';
import { CLIENT_MEMBERS, OPERATION_LOCALS } from './reserved.js';
import { optional, type RubyType, type RubyTypeResolver } from './types.js';

const STYLE = {
  simple: ':simple',
  label: ':label',
  matrix: ':matrix',
  form: ':form',
  spaceDelimited: ':space_delimited',
  pipeDelimited: ':pipe_delimited',
  deepObject: ':deep_object',
} as const;

export type ServiceName = { group: string; className: string; reader: string; file: string };
/** An operation method's RBS signature (`def <method>: <signature>`) and doc text. */
export type MethodSignature = { method: string; signature: string };

/** Operations that pass the plugin's include / exclude (same rules as the C# plugin). */
export function selectOperations(ops: IROperation[], opts: RubyPluginOptions): IROperation[] {
  return selectCsOperations(ops, { include: opts.include, exclude: opts.exclude } as Parameters<typeof selectCsOperations>[1]);
}

/** One service per group (`Default` without one): class `<Group>Service`, client reader `<group>` (snake_case). */
export function buildServiceNames(ops: IROperation[]): Map<string, Omit<ServiceName, 'file'>> {
  const classes = new UniqueNamer([], { caseInsensitive: true });
  const readers = new UniqueNamer(CLIENT_MEMBERS);
  const out = new Map<string, Omit<ServiceName, 'file'>>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    let reader = rubyIdentifier(group);
    if (CLIENT_MEMBERS.includes(reader)) reader = `${reader}_`;
    out.set(group, { group, className: classes.claim(`${constant(toCase(group, 'PascalCase'))}Service`), reader: readers.claim(reader) });
  }
  return out;
}

type Param = { ir: IRParameter; name: string; type: RubyType; required: boolean };
type Body = { media: IRMediaType; type: RubyType; required: boolean };
export type OperationNames = { method: string; constant: string };

/** `services/<group>.rb` for every group; returns the generated names per operation id. */
export function renderServices(
  ctx: PluginContext<RubyPluginOptions>,
  ops: IROperation[],
  services: Map<string, Omit<ServiceName, 'file'>>,
  names: RubyNames,
  resolver: RubyTypeResolver,
  moduleName: string,
): {
  files: { path: string; content: string }[];
  services: (ServiceName & { methods: MethodSignature[] })[];
  operations: Map<string, OperationNames & ServiceName>;
} {
  const files: { path: string; content: string }[] = [];
  const out: (ServiceName & { methods: MethodSignature[] })[] = [];
  const operations = new Map<string, OperationNames & ServiceName>();
  for (const service of services.values()) {
    const file = names.claimFile('services', toCase(service.className.replace(/Service$/, '') || service.className, 'snake_case'));
    const named = { ...service, file };
    const signatures: MethodSignature[] = [];
    out.push({ ...named, methods: signatures });
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const methods = new UniqueNamer(['initialize']);
    const constants = new UniqueNamer();
    const content = rbFile(ctx, moduleName, (w) => {
      w.line(
        members.some((op) => op.group === undefined)
          ? '# The operations without a group.'
          : `# The operations of the group ${rbString(service.group)}.`,
      );
      w.block(`class ${service.className}`, () => {
        w.line('# @param client [Core::Client]');
        w.block('def initialize(client)', () => w.line('@client = client'), 'end');
        const specs: { op: IROperation; n: OperationNames; body: Body | undefined }[] = [];
        for (const op of members) {
          const method = methods.claim(rubyIdentifier(ctx.options.hooks.methodName?.(op) ?? applyTemplate(ctx.options.naming.method?.name, op.name), ctx.options.naming.method?.case ?? 'snake_case'));
          const n = { method, constant: constants.claim(screaming(method)) };
          operations.set(op.id, { ...n, ...named });
          w.blank();
          const rendered = renderOperation(ctx, w, op, n, resolver);
          signatures.push({ method, signature: rendered.signature });
          specs.push({ op, n, body: rendered.body });
        }
        for (const { op, n, body } of specs) {
          w.blank();
          renderSpec(w, op, n, body, resolver);
        }
        if (specs.length > 0) w.line(`private_constant ${specs.map((s) => `:${s.n.constant}`).join(', ')}`);
      }, 'end');
    });
    files.push({ path: file, content });
  }
  return { files, services: out, operations };
}

function requestBody(ctx: PluginContext<RubyPluginOptions>, op: IROperation, resolver: RubyTypeResolver): Body | undefined {
  const content = op.requestBody?.contents[0];
  if (!content) return undefined;
  if (op.method === 'get' || op.method === 'head') {
    ctx.diagnostics.warn('request-body-ignored', `The request body of "${op.id}" is ignored: ${op.method.toUpperCase()} requests do not carry one.`);
    return undefined;
  }
  const required = op.requestBody?.required === true;
  const path = ['operations', op.id, 'requestBody', content.mediaType];
  const type: RubyType =
    content.kind === 'text'
      ? { expr: 'Core::Types::STRING', rbs: '::String', doc: '::String' }
      : content.kind === 'binary'
        ? { expr: 'Core::Types::UPLOAD', rbs: 'Core::Upload | ::String', doc: 'Core::Upload, ::String' }
        : resolver.typeOf(content.schema, path);
  return { media: content, type, required };
}

/** Writes the method; returns the operation's body, if any, and the method's RBS signature. */
function renderOperation(
  ctx: PluginContext<RubyPluginOptions>,
  w: CodeWriter,
  op: IROperation,
  n: OperationNames,
  resolver: RubyTypeResolver,
): { body: Body | undefined; signature: string } {
  const taken = new UniqueNamer(OPERATION_LOCALS);
  const params: Param[] = op.parameters.map((p) => ({
    ir: p,
    name: taken.claim(rubyIdentifier(p.name)),
    type: resolver.typeOf(p.schema, ['operations', op.id, 'parameters', p.name]),
    required: p.in === 'path' || p.required,
  }));
  const body = requestBody(ctx, op, resolver);
  const success = successResponse(op.responses)?.contents[0];
  const result = success === undefined ? undefined : success.kind === 'json' ? resolver.typeOf(success.schema, []) : undefined;

  const summary = [op.summary, op.description].filter((s): s is string => s !== undefined && s.trim() !== '');
  const text = withDeprecation([...summary, `\`${op.method.toUpperCase()} ${op.path}\``].join('\n\n'), op.deprecated);
  for (const line of docLines(text)) w.line(line === '' ? '#' : `# ${line}`);
  w.line('#');
  if (body) w.line(`# @param body [${bodyDoc(body)}]${body.required ? '' : ' (optional)'}`);
  for (const p of params) {
    const description = docLines(withEnumNote(withDeprecationNote(p.ir.description ?? p.ir.schema.description, p.ir.deprecated), p.type));
    const type = p.type.model ? `${p.type.doc}, ::Hash` : p.type.doc;
    w.line(`# @param ${p.name} [${p.required ? type : `${type}, nil`}]${description[0] ? ` ${description[0]}` : ''}`);
    for (const line of description.slice(1)) w.line(line === '' ? '#' : `#   ${line}`);
  }
  w.line('# @param request_options [Core::RequestOptions, ::Hash, nil] per-call headers, base URL and middleware extensions');
  w.line('# @yieldparam response [Core::Response] the successful response');
  w.line(`# @return [${returnDoc(success, result)}]`);
  w.line('# @raise [Core::ApiError] for a non-2xx response');

  const args = [
    ...(body ? [body.required ? 'body' : 'body = nil'] : []),
    ...params.map((p) => (p.required ? `${p.name}:` : `${p.name}: nil`)),
    'request_options: nil',
    '&on_response',
  ];
  w.block(`def ${n.method}(${args.join(', ')})`, () => {
    const hasValues = params.length > 0 || body !== undefined;
    if (hasValues) w.line('values = Core::Values.new');
    for (const p of params) {
      const value = p.type.model ? `${p.type.model}.coerce(${p.name})` : p.name;
      w.line(`values.${p.ir.in}(${rbString(p.ir.name)}, ${value})`);
    }
    if (body) {
      const line = `values.${bodyMethod(body)}(${body.type.model ? `${body.type.model}.coerce(body)` : 'body'})`;
      w.line(body.required ? line : `${line} unless body.nil?`);
    }
    w.line(`@client.call(${n.constant}, ${hasValues ? 'values' : 'nil'}, request_options, &on_response)`);
  }, 'end');

  const hash = '::Hash[::Symbol, untyped]';
  const paramRbs = (p: Param) => (p.type.model ? `${p.type.rbs} | ${hash}` : p.type.rbs);
  const rbsArgs = [
    ...(body ? [body.required ? `${bodyRbs(body)} body` : `?${optional(bodyRbs(body))} body`] : []),
    ...params.map((p) => (p.required ? `${p.name}: ${paramRbs(p)}` : `?${p.name}: ${optional(paramRbs(p))}`)),
    '?request_options: Core::request_options',
  ];
  return { body, signature: `(${rbsArgs.join(', ')}) ?{ (Core::Response) -> void } -> ${returnRbs(success, result)}` };
}

function bodyMethod(body: Body): string {
  switch (body.media.kind) {
    case 'json':
      return 'json_body';
    case 'form':
      return 'form_body';
    case 'multipart':
      return 'multipart_body';
    case 'text':
      return 'text_body';
    default:
      return 'binary_body';
  }
}

function bodyDoc(body: Body): string {
  if (body.media.kind === 'form') return body.type.model ? `${body.type.doc}, ::Hash, Core::FormBody` : '::Hash, Core::FormBody';
  if (body.media.kind === 'multipart') return body.type.model ? `${body.type.doc}, ::Hash, Core::MultipartBody` : '::Hash, Core::MultipartBody';
  return body.type.model ? `${body.type.doc}, ::Hash` : body.type.doc;
}

/** The RBS type of a body argument. */
export function bodyRbs(body: { media: IRMediaType; type: RubyType }): string {
  const hash = '::Hash[::Symbol, untyped]';
  if (body.media.kind === 'form') return body.type.model ? `${body.type.rbs} | ${hash} | Core::FormBody` : `${hash} | Core::FormBody`;
  if (body.media.kind === 'multipart') return body.type.model ? `${body.type.rbs} | ${hash} | Core::MultipartBody` : `${hash} | Core::MultipartBody`;
  return body.type.model ? `${body.type.rbs} | ${hash}` : body.type.rbs;
}

function returnDoc(success: IRMediaType | undefined, result: RubyType | undefined): string {
  if (success === undefined) return 'nil';
  if (success.kind === 'json') return `${result?.doc ?? 'Object'}, nil`;
  return '::String';
}

/** The RBS return type of an operation method. */
export function returnRbs(success: IRMediaType | undefined, result: RubyType | undefined): string {
  if (success === undefined) return 'nil';
  if (success.kind === 'json') return optional(result?.rbs ?? 'untyped');
  return '::String';
}

function isSuccess(status: IRResponse['status']): boolean {
  return typeof status === 'number' ? status >= 200 && status < 300 : status === '2XX';
}

/** The lowest 2xx response (`2XX` only when no numeric one exists). */
export function successResponse(responses: IRResponse[]): IRResponse | undefined {
  const numeric = responses
    .filter((r) => typeof r.status === 'number' && isSuccess(r.status))
    .sort((a, b) => (a.status as number) - (b.status as number));
  return numeric[0] ?? responses.find((r) => r.status === '2XX');
}

function contentKind(media: IRMediaType): string {
  return media.kind === 'json' ? ':json' : media.kind === 'binary' ? ':binary' : ':text';
}

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames, body: Body | undefined, resolver: RubyTypeResolver): void {
  const fields: string[] = [
    `name: ${rbString(op.name)}`,
    `http_method: ${rbString(op.method.toUpperCase())}`,
    `path: ${rbString(op.path)}`,
  ];
  if (op.tags.length > 0) fields.push(`tags: [${op.tags.map(rbString).join(', ')}]`);
  if (op.security.length > 0) {
    const requirement = (r: { schemes: { name: string; scopes: string[] }[] }) =>
      r.schemes.length === 0 ? '{}' : `{ ${r.schemes.map((s) => `${rbString(s.name)} => [${s.scopes.map(rbString).join(', ')}]`).join(', ')} }`;
    fields.push(`security: [${op.security.map(requirement).join(', ')}]`);
  }
  if (op.parameters.length > 0) {
    const param = (p: IRParameter) =>
      `Core::ParamSpec.new(name: ${rbString(p.name)}, location: :${p.in}, style: ${STYLE[p.style]}${p.explode ? ', explode: true' : ''}${p.allowReserved ? ', allow_reserved: true' : ''})`;
    fields.push(`params: [\n${op.parameters.map((p) => `  ${param(p)},`).join('\n')}\n]`);
  }
  if (body) {
    fields.push(`body: :${body.media.kind}`);
    fields.push(`media_type: ${rbString(body.media.mediaType)}`);
  }
  const success = successResponse(op.responses)?.contents[0];
  if (success) {
    fields.push(`success: ${contentKind(success)}`);
    if (success.kind === 'json') {
      const type = resolver.typeOf(success.schema, ['operations', op.id, 'responses', 'success', success.mediaType]);
      if (type.expr !== 'Core::Types::ANY') fields.push(`result: ${type.expr}`);
    }
  }
  const errors = op.responses.flatMap((r) => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    if (c.kind !== 'json') return [`${rbString(String(r.status))} => :text`];
    return [`${rbString(String(r.status))} => ${resolver.typeOf(c.schema, ['operations', op.id, 'responses', String(r.status), c.mediaType]).expr}`];
  });
  if (errors.length > 0) fields.push(`errors: {\n${errors.map((e) => `  ${e},`).join('\n')}\n}`);
  writeList(w, `${n.constant} = Core::Operation.new(`, fields);
}
