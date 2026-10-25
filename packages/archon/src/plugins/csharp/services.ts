import type { IRMediaType, IROperation, IRParameter, IRResponse, IRSchema } from '../../ir/types.js';
import { matchesPattern } from '../../passes/filters.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import { block, csFile, escapeXml, G, GEN, literal, summary } from './emit.js';
import type { CSharpPluginOptions } from './index.js';
import { JSON_CONTEXT } from './json-context.js';
import { isFileType } from './models.js';
import { csIdentifier, escapeKeyword, sanitize, type CsNames } from './names.js';
import { RESERVED_MEMBERS } from './reserved.js';
import type { CsType, CsTypeResolver } from './types.js';

const TASK = `${G}.Threading.Tasks.Task`;
const CANCELLATION = `${G}.Threading.CancellationToken`;
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

/** Members of the client class that a service property must not take. */
export const CLIENT_MEMBERS = ['Options', 'Core', 'Use', 'DefaultBaseUrl', 'SecuritySchemes', ...RESERVED_MEMBERS];

export type ServiceName = { group: string; className: string; property: string };

/** Operations that pass the plugin's include / exclude (`matchesPattern` on `op.id`; exclude wins). */
export function selectOperations(ops: IROperation[], opts: CSharpPluginOptions): IROperation[] {
  const matches = (op: IROperation, patterns: string[] | undefined) => patterns?.some((p) => matchesPattern(op.id, p));
  return ops.filter((op) => {
    if (matches(op, opts.exclude)) return false;
    return opts.include === undefined || opts.include.length === 0 || matches(op, opts.include) === true;
  });
}

/** One service per group (`Default` without one): class `<Group>Service`, client property `<Group>`. */
export function buildServiceNames(ops: IROperation[], clientName: string): Map<string, ServiceName> {
  const classes = new UniqueNamer([], { caseInsensitive: true });
  const properties = new UniqueNamer([...CLIENT_MEMBERS, clientName]);
  const out = new Map<string, ServiceName>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    const pascal = csIdentifier(group, 'PascalCase');
    let property = pascal;
    if (CLIENT_MEMBERS.includes(property) || property === clientName) property = `${property}Value`;
    out.set(group, { group, className: classes.claim(`${pascal}Service`), property: properties.claim(property) });
  }
  return out;
}

export type OperationNames = { method: string; withResponse: string; spec: string; errors: string };

type Param = { ir: IRParameter; name: string; type: CsType; nullable: boolean; required: boolean };
type Body = { media: IRMediaType; name: string; type: CsType; required: boolean; nullable: boolean };

/** `Services/<Group>Service.cs` for every group; returns the generated names per operation id. */
export function renderServices(
  ctx: PluginContext<CSharpPluginOptions>,
  ops: IROperation[],
  services: Map<string, ServiceName>,
  names: CsNames,
  resolver: CsTypeResolver,
): { files: { path: string; content: string }[]; operations: Map<string, OperationNames & ServiceName> } {
  const files: { path: string; content: string }[] = [];
  const operations = new Map<string, OperationNames & ServiceName>();
  for (const service of services.values()) {
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const w = csFile(ctx, resolver.namespace, [`${resolver.namespace}.Core`]);
    const memberNames = new UniqueNamer(['_core', service.className, ...RESERVED_MEMBERS]);
    block(w, `public sealed partial class ${service.className}`, () => {
      w.line('private readonly ApiClientCore _core;');
      w.blank();
      block(w, `internal ${service.className}(ApiClientCore core)`, () => {
        w.line('_core = core;');
      });
      for (const op of members) {
        const opNames = operationNames(op, ctx.options, memberNames);
        operations.set(op.id, { ...opNames, ...service });
        renderOperation(ctx, w, op, opNames, names, resolver);
      }
    });
    files.push({ path: `Services/${service.className}.cs`, content: w.toString() });
  }
  return { files, operations };
}

function operationNames(op: IROperation, opts: CSharpPluginOptions, namer: UniqueNamer): OperationNames {
  const rule = opts.naming.method ?? {};
  const base = sanitize(opts.hooks.methodName?.(op) ?? csIdentifier(op.name, rule.case ?? 'PascalCase'));
  const pascal = sanitize(toCase(base, 'PascalCase')) || 'Operation';
  return {
    method: namer.claim(sanitize(applyTemplate(rule.name, base))),
    withResponse: namer.claim(sanitize(applyTemplate(rule.name, `${base}WithResponse`))),
    spec: namer.claim(`${pascal}Spec`),
    errors: namer.claim(`${pascal}Errors`),
  };
}

function renderOperation(ctx: PluginContext<CSharpPluginOptions>, w: CodeWriter, op: IROperation, n: OperationNames, names: CsNames, resolver: CsTypeResolver): void {
  const path = ['operations', op.id];
  const argNames = new UniqueNamer(['requestOptions', 'cancellationToken', 'values', 'body']);
  const params: Param[] = op.parameters.map((p) => {
    const required = p.in === 'path' || p.required;
    const type = resolver.typeOf(p.schema, [...path, 'parameters', p.name], 'parameter');
    return { ir: p, name: escapeKeyword(argNames.claim(csIdentifier(p.name, 'camelCase'))), type, required, nullable: !required || resolver.isNullable(p.schema) };
  });

  let body: Body | undefined;
  const content = op.requestBody?.contents[0];
  if (content && (op.method === 'get' || op.method === 'head')) {
    ctx.diagnostics.warn('request-body-ignored', `The request body of "${op.id}" is ignored: ${op.method.toUpperCase()} requests do not carry one.`);
  } else if (content) {
    const required = op.requestBody?.required === true;
    const type = bodyType(content, resolver, [...path, 'requestBody', content.mediaType]);
    body = { media: content, name: 'body', type, required, nullable: !required || resolver.isNullable(content.schema) };
  }

  const success = successResponse(op.responses);
  const successContent = success?.contents[0];
  const decoder = successContent ? successDecoder(successContent, resolver, [...path, 'responses', String(success?.status), successContent.mediaType]) : undefined;

  const signature = [
    ...params.filter((p) => p.ir.in === 'path').map(arg),
    ...(body?.required ? [arg(body)] : []),
    ...params.filter((p) => p.ir.in !== 'path' && p.required).map(arg),
    ...(body && !body.required ? [arg(body)] : []),
    ...params.filter((p) => !p.required).map(arg),
    'RequestOptions? requestOptions = null',
    `${CANCELLATION} cancellationToken = default`,
  ].join(', ');
  const callArgs = [
    ...params.filter((p) => p.ir.in === 'path').map((p) => p.name),
    ...(body?.required ? ['body'] : []),
    ...params.filter((p) => p.ir.in !== 'path' && p.required).map((p) => p.name),
    ...(body && !body.required ? ['body'] : []),
    ...params.filter((p) => !p.required).map((p) => p.name),
    'requestOptions',
    'cancellationToken',
  ].join(', ');

  const doc = () => {
    summary(w, [op.summary, op.description].filter((s) => s !== undefined && s !== '').join('\n\n') || undefined);
    for (const p of params) {
      const description = p.ir.description ?? p.ir.schema.description;
      if (description) w.line(`/// <param name="${p.name.replace(/^@/, '')}">${escapeXml(description).replace(/\n/g, ' ')}</param>`);
    }
    if (op.deprecated) w.line(`[${G}.Obsolete]`);
  };

  const dataType = decoder ? decoder.dataType : undefined;
  w.blank();
  doc();
  if (dataType === undefined) {
    w.line(`public async ${TASK} ${n.method}(${signature})`);
    w.line(`    => await ${n.withResponse}(${callArgs}).ConfigureAwait(false);`);
  } else {
    w.line(`public async ${TASK}<${dataType}> ${n.method}(${signature})`);
    w.line(`    => (await ${n.withResponse}(${callArgs}).ConfigureAwait(false)).Data;`);
  }
  w.blank();
  doc();
  block(w, `public ${TASK}<${dataType === undefined ? 'ApiResult' : `ApiResult<${dataType}>`}> ${n.withResponse}(${signature})`, () => {
    const chain = params.map((p) => {
      const info = resolver.register(p.type, p.nullable);
      return `.${PARAM_IN[p.ir.in]}(${literal(p.ir.name)}, ${p.name}, ${JSON_CONTEXT}.Default.${info})`;
    });
    const bodyCall = body ? bodyExpression(body, names, resolver) : undefined;
    if (bodyCall && body?.required) chain.push(bodyCall);
    if (chain.length === 0) {
      w.line('var values = new RequestValues();');
    } else {
      w.line('var values = new RequestValues()');
      w.indent(() => chain.forEach((c, i) => w.line(`${c}${i === chain.length - 1 ? ';' : ''}`)));
    }
    if (bodyCall && body && !body.required) w.line(`if (body is not null) values${bodyCall};`);
    w.line(
      decoder
        ? `return _core.SendAsync(${n.spec}, values, ${decoder.expression}, ${n.errors}, requestOptions, cancellationToken);`
        : `return _core.SendAsync(${n.spec}, values, ${n.errors}, requestOptions, cancellationToken);`,
    );
  });
  w.blank();
  renderSpec(w, op, n, body);
  w.blank();
  renderErrors(w, op, n, resolver);
}

function arg(p: { name: string; type: CsType; nullable: boolean; required: boolean }): string {
  return `${p.nullable ? `${p.type.code}?` : p.type.code} ${p.name}${p.required ? '' : ' = null'}`;
}

/** The C# type of a request body: the schema's type, or the runtime body for non-object form / multipart schemas. */
function bodyType(media: IRMediaType, resolver: CsTypeResolver, path: string[]): CsType {
  if (media.kind === 'text') return { code: 'string', valueType: false, info: 'String', friendly: 'String' };
  if ((media.kind === 'form' || media.kind === 'multipart') && objectSchemaName(media.schema, resolver) === undefined) {
    const runtime = media.kind === 'form' ? 'FormBody' : 'MultipartBody';
    return { code: runtime, valueType: false, info: runtime, friendly: runtime };
  }
  return resolver.typeOf(media.schema, path, 'model');
}

/** The named object schema a body refers to (hoisting turns inline objects into refs). */
function objectSchemaName(schema: IRSchema, resolver: CsTypeResolver): string | undefined {
  return schema.kind === 'ref' && resolver.declares(schema.name) && resolver.schema(schema.name)?.kind === 'object' ? schema.name : undefined;
}

function bodyExpression(body: Body, names: CsNames, resolver: CsTypeResolver): string {
  switch (body.media.kind) {
    case 'json':
      return `.JsonBody(body, ${JSON_CONTEXT}.Default.${resolver.register(body.type, body.nullable)})`;
    case 'text':
      return '.TextBody(body)';
    case 'binary':
      return '.BinaryBody(body)';
    case 'form': {
      if (body.type.code === 'FormBody') return '.Body(body)';
      return `.FormBody(body, ${JSON_CONTEXT}.Default.${resolver.register(body.type, body.nullable)})`;
    }
    case 'multipart': {
      const schemaName = objectSchemaName(body.media.schema, resolver);
      if (schemaName === undefined) return '.Body(body)';
      const schema = resolver.schema(schemaName);
      const members = names.members(schemaName);
      const parts = (schema?.kind === 'object' ? schema.properties : []).map((p) => {
        const type = resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name], 'model');
        const member = `body.${members.get(p.name)}`;
        if (isFileType(type, resolver)) return `.${type.code.startsWith(GEN) ? 'AddFiles' : 'AddFile'}(${literal(p.name)}, ${member})`;
        const info = resolver.register(type, !p.required || resolver.isNullable(p.schema));
        return `.AddJson(${literal(p.name)}, ${member}, ${JSON_CONTEXT}.Default.${info})`;
      });
      return `.Body(new MultipartBody()\n    ${parts.join('\n    ')})`;
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

function successDecoder(media: IRMediaType, resolver: CsTypeResolver, path: string[]): { dataType: string; expression: string } {
  switch (media.kind) {
    case 'json': {
      const type = resolver.typeOf(media.schema, path, 'model');
      const nullable = resolver.isNullable(media.schema);
      return { dataType: resolver.nullableCode(type, nullable), expression: `ResponseDecoder.Json(${JSON_CONTEXT}.Default.${resolver.register(type, nullable)})` };
    }
    case 'binary':
      return { dataType: 'byte[]', expression: 'ResponseDecoder.Binary' };
    default:
      return { dataType: 'string', expression: 'ResponseDecoder.Text' };
  }
}

function responseKind(r: IRResponse): string {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return 'Empty';
  return kind === 'json' ? 'Json' : kind === 'binary' ? 'Binary' : 'Text';
}

function stringList(values: string[]): string {
  return `[${values.map(literal).join(', ')}]`;
}

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames, body: Body | undefined): void {
  const method = op.method.charAt(0).toUpperCase() + op.method.slice(1);
  const security = op.security
    .map((r) => `new SecurityRequirement([${r.schemes.map((s) => `new SecurityScheme(${literal(s.name)}, ${stringList(s.scopes)})`).join(', ')}])`)
    .join(', ');
  const params = op.parameters
    .map((p) => `new ParamSpec(${literal(p.name)}, ParamLocation.${PARAM_IN[p.in]}, ParamStyle.${STYLE[p.style]}, ${p.explode}${p.allowReserved ? ', AllowReserved: true' : ''})`)
    .join(', ');
  const responses = op.responses.map((r) => `[${literal(String(r.status))}] = ResponseKind.${responseKind(r)}`).join(', ');
  w.line(`private static readonly OperationSpec ${n.spec} = new(`);
  w.indent(() => {
    w.line(`${literal(op.name)},`);
    w.line(`${G}.Net.Http.HttpMethod.${method},`);
    w.line(`${literal(op.path)},`);
    w.line(`${stringList(op.tags)},`);
    w.line(`[${security}],`);
    w.line(`[${params}],`);
    w.line(body ? `BodyKind.${BODY_KIND[body.media.kind]}, ${literal(body.media.mediaType)},` : 'null,');
    if (!body) w.line('null,');
    w.line(`new ${GEN}.Dictionary<string, ResponseKind>${responses === '' ? '()' : ` { ${responses} }`});`);
  });
}

function renderErrors(w: CodeWriter, op: IROperation, n: OperationNames, resolver: CsTypeResolver): void {
  const decoders = op.responses.flatMap((r) => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    const status = literal(String(r.status));
    if (c.kind !== 'json') return [`.Text(${status})`];
    const type = resolver.typeOf(c.schema, ['operations', op.id, 'responses', String(r.status), c.mediaType], 'model');
    return [`.Json(${status}, ${JSON_CONTEXT}.Default.${resolver.register(type)})`];
  });
  if (decoders.length === 0) {
    w.line(`private static readonly ErrorDecoders ${n.errors} = ErrorDecoders.None;`);
    return;
  }
  w.line(`private static readonly ErrorDecoders ${n.errors} = new ErrorDecoders()`);
  w.indent(() => decoders.forEach((d, i) => w.line(`${d}${i === decoders.length - 1 ? ';' : ''}`)));
}

