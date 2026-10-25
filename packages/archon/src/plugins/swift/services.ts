import type { IRMediaType, IROperation, IRParameter, IRResponse, IRSchema } from '../../ir/types.js';
import { matchesPattern } from '../../passes/filters.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, UniqueNamer } from '../../writer/naming.js';
import { block, doc, literal, swiftFile } from './emit.js';
import type { SwiftPluginOptions } from './index.js';
import type { ModelContext } from './models.js';
import { escape, sanitize, swIdentifier } from './names.js';
import { optional, type SwType } from './types.js';

const PARAM_IN = { path: 'path', query: 'query', header: 'header', cookie: 'cookie' } as const;

/** Members of the client class that a service property must not take. */
export const CLIENT_MEMBERS: string[] = ['options', 'core', 'use', 'defaultBaseUrl', 'securitySchemes', 'init', 'self', 'hashValue'];

export type ServiceName = { group: string; typeName: string; property: string };

/** Operations that pass the plugin's include / exclude (`matchesPattern` on `op.id`; exclude wins). */
export function selectOperations(ops: IROperation[], opts: SwiftPluginOptions): IROperation[] {
  const matches = (op: IROperation, patterns: string[] | undefined) => patterns?.some((p) => matchesPattern(op.id, p));
  return ops.filter((op) => {
    if (matches(op, opts.exclude)) return false;
    return opts.include === undefined || opts.include.length === 0 || matches(op, opts.include) === true;
  });
}

/** One service per group (`Default` without one): struct `<Group>Service`, client property `<group>`. */
export function buildServiceNames(ops: IROperation[]): Map<string, ServiceName> {
  const types = new UniqueNamer([], { caseInsensitive: true });
  const properties = new UniqueNamer(CLIENT_MEMBERS);
  const out = new Map<string, ServiceName>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    const pascal = swIdentifier(group, 'PascalCase');
    out.set(group, { group, typeName: types.claim(`${pascal}Service`), property: properties.claim(swIdentifier(group, 'camelCase')) });
  }
  return out;
}

export type OperationNames = { method: string; withResponse: string; spec: string; errors: string };

type Param = { ir: IRParameter; name: string; code: string; required: boolean };
type Body = { media: IRMediaType; code: string; required: boolean; type: SwType };

/** `Sources/<Module>/Services/<Group>Service.swift` for every group; returns the generated names per operation id. */
export function renderServices(
  m: ModelContext,
  ops: IROperation[],
  services: Map<string, ServiceName>,
): { files: { path: string; content: string }[]; operations: Map<string, OperationNames & ServiceName> } {
  const files: { path: string; content: string }[] = [];
  const operations = new Map<string, OperationNames & ServiceName>();
  for (const service of services.values()) {
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const w = swiftFile(m.ctx, m.imports);
    const memberNames = new UniqueNamer(['core', 'init', 'self']);
    const rendered: { op: IROperation; names: OperationNames }[] = [];
    block(w, `public struct ${service.typeName}: Sendable`, () => {
      w.line('let core: ApiClientCore');
      w.blank();
      block(w, 'init(core: ApiClientCore)', () => {
        w.line('self.core = core');
      });
      for (const op of members) {
        const names = operationNames(op, m.ctx.options, memberNames);
        operations.set(op.id, { ...names, ...service });
        rendered.push({ op, names });
        renderOperation(m, w, op, names);
      }
    });
    if (rendered.length > 0) {
      w.blank();
      block(w, `extension ${service.typeName}`, () => {
        rendered.forEach(({ op, names }, i) => {
          if (i > 0) w.blank();
          renderSpec(w, op, names);
          w.blank();
          renderErrors(m, w, op, names);
        });
      });
    }
    files.push({ path: `${m.dir}/Services/${service.typeName}.swift`, content: w.toString() });
  }
  return { files, operations };
}

function operationNames(op: IROperation, opts: SwiftPluginOptions, namer: UniqueNamer): OperationNames {
  const rule = opts.naming.method ?? {};
  const base = sanitize(opts.hooks.methodName?.(op) ?? swIdentifier(op.name, rule.case ?? 'camelCase'));
  return {
    method: namer.claim(sanitize(applyTemplate(rule.name, base))),
    withResponse: namer.claim(sanitize(applyTemplate(rule.name, `${base}WithResponse`))),
    spec: namer.claim(`${base}Spec`),
    errors: namer.claim(`${base}Errors`),
  };
}

function renderOperation(m: ModelContext, w: CodeWriter, op: IROperation, n: OperationNames): void {
  const { resolver } = m;
  const path = ['operations', op.id];
  const argNames = new UniqueNamer(['options', 'values', 'body', 'multipart', 'self']);
  const params: Param[] = op.parameters.map((p) => {
    const required = p.in === 'path' || p.required;
    const type = resolver.typeOf(p.schema, [...path, 'parameters', p.name]);
    const nullable = !required || resolver.isNullable(p.schema);
    return { ir: p, name: argNames.claim(swIdentifier(p.name, 'camelCase')), code: optional(type.code, nullable), required };
  });

  let body: Body | undefined;
  const content = op.requestBody?.contents[0];
  if (content && (op.method === 'get' || op.method === 'head')) {
    m.ctx.diagnostics.warn('request-body-ignored', `The request body of "${op.id}" is ignored: ${op.method.toUpperCase()} requests do not carry one.`);
  } else if (content) {
    const required = op.requestBody?.required === true;
    const type = bodyType(m, content, [...path, 'requestBody', content.mediaType]);
    body = { media: content, type, required, code: optional(type.code, !required || resolver.isNullable(content.schema)) };
  }

  const success = successResponse(op.responses);
  const successContent = success?.contents[0];
  const decoder = successContent ? successDecoder(m, successContent, [...path, 'responses', String(success?.status), successContent.mediaType]) : undefined;

  const arg = (name: string, code: string, required: boolean) => `${escape(name)}: ${code}${required ? '' : ' = nil'}`;
  const ordered = [
    ...params.filter((p) => p.ir.in === 'path').map((p) => ({ name: p.name, code: p.code, required: true })),
    ...(body?.required ? [{ name: 'body', code: body.code, required: true }] : []),
    ...params.filter((p) => p.ir.in !== 'path' && p.required).map((p) => ({ name: p.name, code: p.code, required: true })),
    ...(body && !body.required ? [{ name: 'body', code: body.code, required: false }] : []),
    ...params.filter((p) => !p.required).map((p) => ({ name: p.name, code: p.code, required: false })),
  ];
  const signature = [...ordered.map((a) => arg(a.name, a.code, a.required)), 'options: RequestOptions? = nil'].join(', ');
  const callArgs = [...ordered.map((a) => `${a.name}: ${escape(a.name)}`), 'options: options'].join(', ');

  const docs = () => {
    doc(w, [op.summary, op.description].filter((s) => s !== undefined && s !== '').join('\n\n') || undefined);
    const described = params.flatMap((p) => {
      const description = p.ir.description ?? p.ir.schema.description;
      return description ? [{ name: p.name, text: description.replace(/\s*\n\s*/g, ' ') }] : [];
    });
    if (described.length > 0) {
      if (op.summary || op.description) w.line('///');
      w.line('/// - Parameters:');
      for (const d of described) w.line(`///   - ${d.name}: ${d.text}`);
    }
    if (op.deprecated) w.line('@available(*, deprecated)');
  };

  const dataType = decoder?.dataType;
  w.blank();
  docs();
  block(w, `public func ${escape(n.method)}(${signature}) async throws${dataType === undefined ? '' : ` -> ${dataType}`}`, () => {
    w.line(dataType === undefined ? `_ = try await ${escape(n.withResponse)}(${callArgs})` : `try await ${escape(n.withResponse)}(${callArgs}).data`);
  });
  w.blank();
  docs();
  block(w, `public func ${escape(n.withResponse)}(${signature}) async throws -> ApiResult<${dataType ?? m.names.std('Void')}>`, () => {
    const lines = params.map((p) => `try values.${PARAM_IN[p.ir.in]}(${literal(p.ir.name)}, ${escape(p.name)})`);
    w.line(`${lines.length > 0 || body ? 'var' : 'let'} values = RequestValues()`);
    for (const l of lines) w.line(l);
    if (body) {
      if (body.required) bodyStatements(m, w, body, 'body');
      else block(w, 'if let body', () => bodyStatements(m, w, body as Body, 'body'));
    }
    w.line(
      decoder
        ? `return try await core.send(Self.${n.spec}, values, decoder: ${decoder.expression}, errors: Self.${n.errors}, options: options)`
        : `return try await core.send(Self.${n.spec}, values, errors: Self.${n.errors}, options: options)`,
    );
  });
}

/** The Swift type of a request body: the schema's type, or the runtime's for text / binary / non-object multipart. */
function bodyType(m: ModelContext, media: IRMediaType, path: string[]): SwType {
  const { std } = m.names;
  if (media.kind === 'text') return { code: std('String'), friendly: 'String' };
  if (media.kind === 'binary') return { code: std('Data'), friendly: 'Data' };
  if (media.kind === 'multipart' && objectSchemaName(m, media.schema) === undefined) return { code: 'MultipartBody', friendly: 'MultipartBody' };
  return m.resolver.typeOf({ ...media.schema, nullable: false }, path);
}

/** The named object schema a body refers to (hoisting turns inline objects into refs). */
function objectSchemaName(m: ModelContext, schema: IRSchema): string | undefined {
  return schema.kind === 'ref' && m.resolver.declares(schema.name) && m.resolver.schema(schema.name)?.kind === 'object' ? schema.name : undefined;
}

function bodyStatements(m: ModelContext, w: CodeWriter, body: Body, name: string): void {
  switch (body.media.kind) {
    case 'json':
      w.line(`try values.json(${name})`);
      return;
    case 'form':
      w.line(`try values.form(${name})`);
      return;
    case 'text':
      w.line(`values.text(${name})`);
      return;
    case 'binary':
      w.line(`values.binary(${name})`);
      return;
    case 'multipart': {
      const schemaName = objectSchemaName(m, body.media.schema);
      if (schemaName === undefined) {
        w.line(`values.multipart(${name})`);
        return;
      }
      const schema = m.resolver.schema(schemaName);
      const members = m.names.members(schemaName);
      w.line('var multipart = MultipartBody()');
      for (const p of schema?.kind === 'object' ? schema.properties : []) {
        const type = m.resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name]);
        const member = `${name}.${escape(members.get(p.name) as string)}`;
        if (type.code === 'ApiFile') w.line(`multipart.file(${literal(p.name)}, ${member})`);
        else if (type.code === '[ApiFile]') w.line(`multipart.files(${literal(p.name)}, ${member})`);
        else w.line(`try multipart.field(${literal(p.name)}, ${member})`);
      }
      w.line('values.multipart(multipart)');
      return;
    }
  }
}

function isSuccess(status: IRResponse['status']): boolean {
  return typeof status === 'number' ? status >= 200 && status < 300 : status === '2XX';
}

/** The lowest 2xx response (`2XX` only when no numeric one exists). */
function successResponse(responses: IRResponse[]): IRResponse | undefined {
  const numeric = responses.filter((r) => typeof r.status === 'number' && isSuccess(r.status)).sort((a, b) => (a.status as number) - (b.status as number));
  return numeric[0] ?? responses.find((r) => r.status === '2XX');
}

function successDecoder(m: ModelContext, media: IRMediaType, path: string[]): { dataType: string; expression: string } {
  switch (media.kind) {
    case 'json': {
      const code = optional(m.resolver.typeOf(media.schema, path).code, m.resolver.isNullable(media.schema));
      return { dataType: code, expression: `.json(${code}.self)` };
    }
    case 'binary':
      return { dataType: m.names.std('Data'), expression: '.binary' };
    default:
      return { dataType: m.names.std('String'), expression: '.text' };
  }
}

function responseKind(r: IRResponse): string {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return '.empty';
  return kind === 'json' ? '.json' : kind === 'binary' ? '.binary' : '.text';
}

function stringList(values: string[]): string {
  return `[${values.map(literal).join(', ')}]`;
}

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames): void {
  const security = op.security.map(
    (r) => `SecurityRequirement([${r.schemes.map((s) => `SecurityScheme(${literal(s.name)}${s.scopes.length > 0 ? `, scopes: ${stringList(s.scopes)}` : ''})`).join(', ')}])`,
  );
  const params = op.parameters.map(
    (p) => `ParamSpec(${literal(p.name)}, .${PARAM_IN[p.in]}, .${p.style}, explode: ${p.explode}${p.allowReserved ? ', allowReserved: true' : ''})`,
  );
  const responses = op.responses.map((r) => `${literal(String(r.status))}: ${responseKind(r)}`);
  const content = op.requestBody?.contents[0];
  const body = content && op.method !== 'get' && op.method !== 'head' ? content : undefined;
  const list = (items: string[]) => (items.length === 0 ? '[]' : `[\n${items.map((i) => `    ${i},`).join('\n')}\n]`);
  w.line(`static let ${n.spec} = OperationSpec(`);
  w.indent(() => {
    w.line(`operationName: ${literal(op.name)},`);
    w.line(`method: .${op.method},`);
    w.line(`path: ${literal(op.path)},`);
    w.line(`tags: ${stringList(op.tags)},`);
    w.line(`security: ${list(security)},`);
    w.line(`params: ${list(params)},`);
    if (body) {
      w.line(`body: .${body.kind},`);
      w.line(`bodyMediaType: ${literal(body.mediaType)},`);
    }
    w.line(`responses: ${responses.length === 0 ? '[:]' : `[${responses.join(', ')}]`}`);
  });
  w.line(')');
}

function renderErrors(m: ModelContext, w: CodeWriter, op: IROperation, n: OperationNames): void {
  const decoders = op.responses.flatMap((r) => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    const status = literal(String(r.status));
    if (c.kind !== 'json') return [`.text(${status})`];
    const type = m.resolver.typeOf({ ...c.schema, nullable: false }, ['operations', op.id, 'responses', String(r.status), c.mediaType]);
    return [`.json(${status}, ${type.code}.self)`];
  });
  if (decoders.length === 0) {
    w.line(`static let ${n.errors} = ErrorDecoders.none`);
    return;
  }
  w.line(`static let ${n.errors} = ErrorDecoders()`);
  w.indent(() => decoders.forEach((d) => w.line(d)));
}
