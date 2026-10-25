import type { IRMediaType, IROperation, IRParameter, IRResponse, IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { applyTemplate, toCase, UniqueNamer } from '../../writer/naming.js';
import { selectOperations as selectCsOperations } from '../csharp/services.js';
import { kdoc, ktSource, literal } from './emit.js';
import type { KotlinPluginOptions } from './index.js';
import { bare, escapeKeyword, ktIdentifier, packageCode, packageDir, sanitize, type KtNames } from './names.js';
import type { KtType, KtTypeResolver } from './types.js';

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
const DEPRECATED = '@Deprecated("Deprecated in the API.")';

/** Members of the client class that a service property must not take. */
export const CLIENT_MEMBERS: string[] = ['options', 'core', 'use', 'close'];

export type ServiceName = { group: string; className: string; property: string };
export type OperationNames = { method: string; withResponse: string; spec: string; errors: string };

/** Operations that pass the plugin's include / exclude (same rules as the C# plugin). */
export function selectOperations(ops: IROperation[], opts: KotlinPluginOptions): IROperation[] {
  return selectCsOperations(ops, { include: opts.include, exclude: opts.exclude } as Parameters<typeof selectCsOperations>[1]);
}

/** One service per group (`Default` without one): class `<Group>Service`, client property `<group>`. */
export function buildServiceNames(ops: IROperation[]): Map<string, ServiceName> {
  const classes = new UniqueNamer([], { caseInsensitive: true });
  const properties = new UniqueNamer(CLIENT_MEMBERS);
  const out = new Map<string, ServiceName>();
  for (const op of ops) {
    const group = op.group ?? 'Default';
    if (out.has(group)) continue;
    let property = ktIdentifier(group, 'camelCase');
    if (CLIENT_MEMBERS.includes(property)) property = `${property}Value`;
    out.set(group, {
      group,
      className: classes.claim(`${ktIdentifier(group, 'PascalCase')}Service`),
      property: escapeKeyword(properties.claim(property)),
    });
  }
  return out;
}

type Param = { ir: IRParameter; name: string; type: KtType; nullable: boolean; required: boolean };
type Body = { media: IRMediaType; name: string; type: KtType; required: boolean; nullable: boolean };

/** `services/<Group>Service.kt` for every group; returns the generated names per operation id. */
export function renderServices(
  ctx: PluginContext<KotlinPluginOptions>,
  ops: IROperation[],
  services: Map<string, ServiceName>,
  names: KtNames,
  resolver: KtTypeResolver,
  runtimeNames: Iterable<string>,
): { files: { path: string; content: string }[]; operations: Map<string, OperationNames & ServiceName> } {
  const files: { path: string; content: string }[] = [];
  const operations = new Map<string, OperationNames & ServiceName>();
  const pkg = resolver.packageName;
  const hasModels = [...ctx.ir.schemas.keys()].some((name) => resolver.declares(name));
  for (const service of services.values()) {
    const members = ops.filter((op) => (op.group ?? 'Default') === service.group);
    const methodNames = new UniqueNamer(['core']);
    const constants = new UniqueNamer();
    const specs: { op: IROperation; n: OperationNames; body: Body | undefined }[] = [];
    const w = ctx.writer({ indent: '    ' });
    w.block(`public class ${service.className} internal constructor(private val core: ApiClientCore) {`, () => {
      members.forEach((op, i) => {
        const n = operationNames(op, ctx.options, methodNames, constants);
        operations.set(op.id, { ...n, ...service });
        if (i > 0) w.blank();
        specs.push({ op, n, body: renderOperation(ctx, w, op, n, names, resolver) });
      });
      w.blank();
      w.block('private companion object {', () => {
        specs.forEach(({ op, n, body }, i) => {
          if (i > 0) w.blank();
          renderSpec(w, op, n, body);
          w.blank();
          renderErrors(w, op, n, resolver);
        });
      });
    });
    files.push({
      path: `${packageDir(pkg)}/services/${service.className}.kt`,
      content: ktSource(ctx, `${pkg}.services`, pkg, runtimeNames, w.toString(), hasModels ? [`${packageCode(pkg)}.models.*`] : []),
    });
  }
  return { files, operations };
}

function operationNames(op: IROperation, opts: KotlinPluginOptions, methods: UniqueNamer, constants: UniqueNamer): OperationNames {
  const rule = opts.naming.method ?? {};
  const base = sanitize(opts.hooks.methodName?.(op) ?? ktIdentifier(op.name, rule.case ?? 'camelCase'));
  const constant = sanitize(toCase(base, 'SCREAMING_SNAKE_CASE')) || 'OPERATION';
  return {
    method: escapeKeyword(methods.claim(sanitize(applyTemplate(rule.name, base)))),
    withResponse: escapeKeyword(methods.claim(sanitize(applyTemplate(rule.name, `${base}WithResponse`)))),
    spec: constants.claim(constant),
    errors: constants.claim(`${constant}_ERRORS`),
  };
}

/** Writes both methods of an operation; returns its body, if any. */
function renderOperation(
  ctx: PluginContext<KotlinPluginOptions>,
  w: CodeWriter,
  op: IROperation,
  n: OperationNames,
  names: KtNames,
  resolver: KtTypeResolver,
): Body | undefined {
  const path = ['operations', op.id];
  const argNames = new UniqueNamer(['requestOptions', 'values', 'body', 'core']);
  const params: Param[] = op.parameters.map((p) => {
    const required = p.in === 'path' || p.required;
    const type = resolver.typeOf(p.schema, [...path, 'parameters', p.name]);
    return {
      ir: p,
      name: escapeKeyword(argNames.claim(ktIdentifier(p.name, 'camelCase'))),
      type,
      required,
      nullable: !required || resolver.isNullable(p.schema),
    };
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
  const decoder = successContent
    ? successDecoder(successContent, resolver, [...path, 'responses', String(success?.status), successContent.mediaType])
    : { dataType: 'Unit', expression: 'ResponseDecoder.empty' };

  const ordered = [
    ...params.filter((p) => p.ir.in === 'path'),
    ...(body?.required ? [body] : []),
    ...params.filter((p) => p.ir.in !== 'path' && p.required),
    ...(body && !body.required ? [body] : []),
    ...params.filter((p) => !p.required),
  ];
  const signature = [...ordered.map(arg), 'requestOptions: RequestOptions? = null'].join(', ');
  const callArgs = [...ordered.map((p) => p.name), 'requestOptions'].join(', ');

  const doc = () => {
    const lines = [[op.summary, op.description].filter((s) => s !== undefined && s !== '').join('\n\n')];
    const tags = params.flatMap((p) => {
      const description = p.ir.description ?? p.ir.schema.description;
      return description ? [`@param ${bare(p.name)} ${description.replace(/\s*\n\s*/g, ' ')}`] : [];
    });
    if (tags.length > 0) lines.push(lines[0] === '' ? tags.join('\n') : `\n${tags.join('\n')}`);
    kdoc(w, lines.filter((l) => l !== '').join('\n'));
    if (op.deprecated) w.line(DEPRECATED);
  };

  doc();
  w.line(`public suspend fun ${n.method}(${signature}): ${decoder.dataType} =`);
  w.indent(() => w.line(`${n.withResponse}(${callArgs}).data`));
  w.blank();
  doc();
  w.block(`public suspend fun ${n.withResponse}(${signature}): ApiResult<${decoder.dataType}> {`, () => {
    const chain = params.map((p) => `.${p.ir.in}(${literal(p.ir.name)}, ${p.name}, ${p.nullable ? `${p.type.serializer}.nullable` : p.type.serializer})`);
    const bodyCall = body ? bodyExpression(body, names, resolver) : undefined;
    if (bodyCall && body?.required) chain.push(bodyCall);
    w.line('val values = RequestValues()');
    w.indent(() => chain.forEach((c) => w.line(c)));
    if (bodyCall && body && !body.required) w.line(`if (body != null) values${bodyCall}`);
    w.line(`return core.send(${n.spec}, values, ${decoder.expression}, ${n.errors}, requestOptions)`);
  });
  return body;
}

function arg(p: { name: string; type: KtType; nullable: boolean; required: boolean }): string {
  return `${p.name}: ${p.type.code}${p.nullable ? '?' : ''}${p.required ? '' : ' = null'}`;
}

const TEXT: KtType = { code: 'String', serializer: 'String.serializer()', friendly: 'String', decl: 'String' };

/** The Kotlin type of a request body: the schema's type, or the runtime body for non-object form / multipart schemas. */
function bodyType(media: IRMediaType, resolver: KtTypeResolver, path: string[]): KtType {
  if (media.kind === 'text') return TEXT;
  if (media.kind === 'binary') return { code: 'ApiFile', serializer: 'ApiFile.Serializer', friendly: 'ApiFile', decl: 'ApiFile' };
  if ((media.kind === 'form' || media.kind === 'multipart') && objectSchemaName(media.schema, resolver) === undefined) {
    const runtime = media.kind === 'form' ? 'FormBody' : 'MultipartBody';
    return { code: runtime, serializer: '', friendly: runtime, decl: runtime };
  }
  return resolver.typeOf(media.schema, path);
}

/** The named object schema a body refers to (hoisting turns inline objects into refs). */
function objectSchemaName(schema: IRSchema, resolver: KtTypeResolver): string | undefined {
  return schema.kind === 'ref' && resolver.declares(schema.name) && resolver.schema(schema.name)?.kind === 'object' ? schema.name : undefined;
}

function bodyExpression(body: Body, names: KtNames, resolver: KtTypeResolver): string {
  // A required but nullable body may be null; an optional one is only sent when it is not.
  const serializer = body.required && body.nullable ? `${body.type.serializer}.nullable` : body.type.serializer;
  switch (body.media.kind) {
    case 'json':
      return `.jsonBody(body, ${serializer})`;
    case 'text':
      return '.textBody(body)';
    case 'binary':
      return '.binaryBody(body)';
    case 'form':
      return body.type.code === 'FormBody' ? '.body(body)' : `.formBody(body, ${serializer})`;
    case 'multipart': {
      const schemaName = objectSchemaName(body.media.schema, resolver);
      if (schemaName === undefined) return '.body(body)';
      const schema = resolver.schema(schemaName);
      const members = names.members(schemaName);
      const parts = (schema?.kind === 'object' ? schema.properties : []).map((p) => {
        const type = resolver.typeOf(p.schema, ['schemas', schemaName, 'properties', p.name]);
        const member = `body.${members.get(p.name)}`;
        if (type.code === 'ApiFile') return `.addFile(${literal(p.name)}, ${member})`;
        if (type.code === 'List<ApiFile>') return `.addFiles(${literal(p.name)}, ${member})`;
        const nullable = !p.required || resolver.isNullable(p.schema);
        return `.addJson(${literal(p.name)}, ${member}, ${nullable ? `${type.serializer}.nullable` : type.serializer})`;
      });
      return `.body(\n    MultipartBody()\n${parts.map((p) => `        ${p}`).join('\n')},\n)`;
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

function successDecoder(media: IRMediaType, resolver: KtTypeResolver, path: string[]): { dataType: string; expression: string } {
  switch (media.kind) {
    case 'json': {
      const type = resolver.usage(media.schema, path);
      return { dataType: type.code, expression: `ResponseDecoder.json(${type.serializer})` };
    }
    case 'binary':
      return { dataType: 'ByteArray', expression: 'ResponseDecoder.binary' };
    default:
      return { dataType: 'String', expression: 'ResponseDecoder.text' };
  }
}

function responseKind(r: IRResponse): string {
  const kind = r.contents[0]?.kind;
  if (kind === undefined) return 'Empty';
  return kind === 'json' ? 'Json' : kind === 'binary' ? 'Binary' : 'Text';
}

function list(items: string[]): string {
  return items.length === 0 ? 'emptyList()' : `listOf(${items.join(', ')})`;
}

const METHODS: Record<IROperation['method'], string> = {
  get: 'HttpMethod.Get',
  put: 'HttpMethod.Put',
  post: 'HttpMethod.Post',
  delete: 'HttpMethod.Delete',
  options: 'HttpMethod.Options',
  head: 'HttpMethod.Head',
  patch: 'HttpMethod.Patch',
  trace: 'HttpMethod("TRACE")',
};

function renderSpec(w: CodeWriter, op: IROperation, n: OperationNames, body: Body | undefined): void {
  const security = op.security.map((r) => `SecurityRequirement(${list(r.schemes.map((s) => `SecurityScheme(${literal(s.name)}, ${list(s.scopes.map(literal))})`))})`);
  const params = op.parameters.map(
    (p) => `ParamSpec(${literal(p.name)}, ParamLocation.${PARAM_IN[p.in]}, ParamStyle.${STYLE[p.style]}, ${p.explode}${p.allowReserved ? ', allowReserved = true' : ''})`,
  );
  const responses = op.responses.map((r) => `${literal(String(r.status))} to ResponseKind.${responseKind(r)}`);
  w.line(`val ${n.spec}: OperationSpec = OperationSpec(`);
  w.indent(() => {
    w.line(`${literal(op.name)},`);
    w.line(`${METHODS[op.method]},`);
    w.line(`${literal(op.path)},`);
    w.line(`${list(op.tags.map(literal))},`);
    w.line(`${list(security)},`);
    w.line(`${list(params)},`);
    w.line(body ? `BodyKind.${BODY_KIND[body.media.kind]}, ${literal(body.media.mediaType)},` : 'null,');
    if (!body) w.line('null,');
    w.line(`${responses.length === 0 ? 'emptyMap()' : `mapOf(${responses.join(', ')})`},`);
  });
  w.line(')');
}

function renderErrors(w: CodeWriter, op: IROperation, n: OperationNames, resolver: KtTypeResolver): void {
  const decoders = op.responses.flatMap((r) => {
    const c = r.contents[0];
    if (isSuccess(r.status) || c === undefined) return [];
    const status = literal(String(r.status));
    if (c.kind !== 'json') return [`.text(${status})`];
    const type = resolver.typeOf(c.schema, ['operations', op.id, 'responses', String(r.status), c.mediaType]);
    return [`.json(${status}, ${type.serializer})`];
  });
  if (decoders.length === 0) {
    w.line(`val ${n.errors}: ErrorDecoders = ErrorDecoders.None`);
    return;
  }
  w.line(`val ${n.errors}: ErrorDecoders = ErrorDecoders()`);
  w.indent(() => decoders.forEach((d) => w.line(d)));
}
