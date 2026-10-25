import type { Diagnostics } from '../diagnostics.js';
import type {
  IRMediaType,
  IROAuthFlow,
  IROAuthFlows,
  IROperation,
  IRParameter,
  IRResponse,
  IRSchema,
  IRSecurityRequirement,
  IRSecurityScheme,
  IRServer,
} from '../ir/types.js';
import type { OpenAPIDocument } from '../loader/load.js';
import { toCase, UniqueNamer } from '../writer/naming.js';
import { deriveOperationName } from './naming.js';
import { escapePointer, parseSchema, resolvePointer, type SchemaContext } from './schema.js';

type Obj = Record<string, unknown>;
type Method = IROperation['method'];

export type ParserHooks = {
  operationName?: (op: IROperation, ctx: { derived: string }) => string | undefined;
  operationGroup?: (op: IROperation) => string | undefined;
};

const METHODS: readonly Method[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MEDIA_KIND_PRIORITY: Record<IRMediaType['kind'], number> = { json: 0, multipart: 1, form: 2, text: 3, binary: 4 };
const STYLES: readonly IRParameter['style'][] = [
  'simple',
  'label',
  'matrix',
  'form',
  'spaceDelimited',
  'pipeDelimited',
  'deepObject',
];
const PARAMETER_LOCATIONS: readonly IRParameter['in'][] = ['path', 'query', 'header', 'cookie'];

// ---------------------------------------------------------------------------
// operations

export function parseOperations(doc: OpenAPIDocument, ctx: SchemaContext, hooks: ParserHooks = {}): IROperation[] {
  const paths: unknown = doc['paths'];
  const out: IROperation[] = [];
  if (!isRecord(paths)) return out;

  const namer = new UniqueNamer();
  const rootSecurity = doc['security'];
  const schemes: unknown = doc['components']?.['securitySchemes'];
  const definedSchemes = new Set(isRecord(schemes) ? Object.keys(schemes) : []);

  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const itemPointer = `#/paths/${escapePointer(path)}`;
    for (const method of METHODS) {
      const node = item[method];
      if (!isRecord(node)) continue;
      const pointer = `${itemPointer}/${method}`;
      const octx = { ...ctx, pointer };

      const derived = deriveOperationName(method, path);
      const operationId = node['operationId'];
      let base = derived;
      if (typeof operationId === 'string' && operationId.length > 0) {
        base = toCase(operationId, 'camelCase');
        if (base === '') {
          base = derived;
          ctx.diagnostics.warn(
            'operation-name-fallback',
            `operationId "${operationId}" of ${method.toUpperCase()} ${path} has no ASCII letters or digits; using the derived name "${derived}"`,
            pointer,
          );
        }
      }
      const tags = stringArray(node['tags']);
      const servers = node['servers'] ?? item['servers'];
      const requestBody = parseRequestBody(node['requestBody'], octx);

      const op: IROperation = {
        id: `${method.toUpperCase()} ${path}`,
        name: base,
        method,
        path,
        tags,
        ...(typeof node['summary'] === 'string' && { summary: node['summary'] }),
        ...(typeof node['description'] === 'string' && { description: node['description'] }),
        deprecated: node['deprecated'] === true,
        parameters: parseParameters(item, node, itemPointer, pointer, octx),
        ...(requestBody && { requestBody }),
        responses: parseResponses(node['responses'], octx),
        security: parseSecurityRequirements(Array.isArray(node['security']) ? node['security'] : rootSecurity),
        ...(Array.isArray(servers) && { servers: parseServers(servers) }),
      };

      for (const name of new Set(op.security.flatMap((r) => r.schemes.map((x) => x.name)))) {
        if (definedSchemes.has(name)) continue;
        ctx.diagnostics.warn(
          'unknown-security-scheme',
          `${op.id} requires security scheme "${name}", which is not defined in components.securitySchemes`,
          pointer,
        );
      }

      const hooked = hooks.operationName?.(op, { derived });
      const wanted = typeof hooked === 'string' && hooked.length > 0 ? hooked : base;
      op.name = namer.claim(wanted);
      if (op.name !== wanted) {
        ctx.diagnostics.info('operation-renamed', `Operation name "${wanted}" of ${op.id} is already used; renamed to "${op.name}"`, pointer);
      }

      const group = hooks.operationGroup?.(op) ?? tags[0];
      if (group !== undefined) op.group = group;
      out.push(op);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parameters

function parseParameters(item: Obj, node: Obj, itemPointer: string, opPointer: string, ctx: SchemaContext): IRParameter[] {
  const merged = new Map<string, IRParameter>();
  const sources: [unknown, string][] = [
    [item['parameters'], `${itemPointer}/parameters`],
    [node['parameters'], `${opPointer}/parameters`],
  ];
  for (const [list, pointer] of sources) {
    if (!Array.isArray(list)) continue;
    list.forEach((raw, i) => {
      const param = parseParameter(raw, { ...ctx, pointer: `${pointer}/${i}` });
      merged.set(`${param.in}:${param.name}`, param);
    });
  }
  return [...merged.values()];
}

function parseParameter(raw: unknown, ctx: SchemaContext): IRParameter {
  const node = deref(raw, ctx);
  const name = node['name'];
  const location = node['in'];
  if (typeof name !== 'string' || !isOneOf(PARAMETER_LOCATIONS, location)) {
    return ctx.diagnostics.error('invalid-parameter', 'Parameter must have a string "name" and a valid "in"', ctx.pointer);
  }

  // `content` 形式は schema を唯一のエントリから取り、style は既定値にする。
  const content = node['content'];
  const entry = node['schema'] === undefined && isRecord(content) ? Object.entries(content)[0] : undefined;
  let schema: IRSchema;
  let style: IRParameter['style'];
  if (entry) {
    const [mediaType, media] = entry;
    schema = parseSchema(isRecord(media) ? media['schema'] : undefined, {
      ...ctx,
      pointer: `${ctx.pointer}/content/${escapePointer(mediaType)}/schema`,
    });
    style = defaultStyle(location);
  } else {
    schema = parseSchema(node['schema'], { ...ctx, pointer: `${ctx.pointer}/schema` });
    style = isOneOf(STYLES, node['style']) ? node['style'] : defaultStyle(location);
  }
  const explode = !entry && typeof node['explode'] === 'boolean' ? node['explode'] : style === 'form';

  return {
    name,
    in: location,
    required: location === 'path' || node['required'] === true,
    deprecated: node['deprecated'] === true,
    ...(typeof node['description'] === 'string' && { description: node['description'] }),
    schema,
    style,
    explode,
    // allowReserved is only defined for query parameters.
    allowReserved: location === 'query' && node['allowReserved'] === true,
  };
}

function defaultStyle(location: IRParameter['in']): IRParameter['style'] {
  return location === 'query' || location === 'cookie' ? 'form' : 'simple';
}

// ---------------------------------------------------------------------------
// request body / responses

function parseRequestBody(raw: unknown, ctx: SchemaContext): IROperation['requestBody'] {
  if (raw === undefined) return undefined;
  const pointer = `${ctx.pointer}/requestBody`;
  const bctx = { ...ctx, pointer };
  const node = deref(raw, bctx);
  const contents = parseContents(node['content'], bctx);

  // 優先順に並べ替え（安定ソート）。先頭以外は採用しない。
  contents.sort((a, b) => MEDIA_KIND_PRIORITY[a.kind] - MEDIA_KIND_PRIORITY[b.kind]);
  const [adopted, ...ignored] = contents;
  for (const alt of ignored) {
    ctx.diagnostics.info(
      'request-body-alternative-ignored',
      `Request body "${alt.mediaType}" is ignored in favor of "${adopted?.mediaType}"`,
      `${pointer}/content/${escapePointer(alt.mediaType)}`,
    );
  }
  return { required: node['required'] === true, contents };
}

function parseResponses(raw: unknown, ctx: SchemaContext): IRResponse[] {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).map(([key, value]) => {
    const pointer = `${ctx.pointer}/responses/${escapePointer(key)}`;
    const rctx = { ...ctx, pointer };
    const node = deref(value, rctx);

    const headers = new Map<string, IRSchema>();
    if (isRecord(node['headers'])) {
      for (const [name, h] of Object.entries(node['headers'])) {
        const hctx = { ...rctx, pointer: `${pointer}/headers/${escapePointer(name)}` };
        const header = deref(h, hctx);
        headers.set(name, parseHeaderSchema(header, hctx));
      }
    }

    return {
      status: parseStatus(key),
      ...(typeof node['description'] === 'string' && { description: node['description'] }),
      headers,
      contents: parseContents(node['content'], rctx),
    };
  });
}

function parseHeaderSchema(header: Obj, ctx: SchemaContext): IRSchema {
  const entry = isRecord(header['content']) ? Object.entries(header['content'])[0] : undefined;
  if (entry && header['schema'] === undefined) {
    const [mediaType, media] = entry;
    return parseSchema(isRecord(media) ? media['schema'] : undefined, {
      ...ctx,
      pointer: `${ctx.pointer}/content/${escapePointer(mediaType)}/schema`,
    });
  }
  return parseSchema(header['schema'], { ...ctx, pointer: `${ctx.pointer}/schema` });
}

function parseStatus(key: string): number | string {
  if (/^\d+$/.test(key)) return Number(key);
  return key === 'default' ? key : key.toUpperCase();
}

function parseContents(raw: unknown, ctx: SchemaContext): IRMediaType[] {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).map(([mediaType, value]) => {
    const media = isRecord(value) ? value : {};
    const pointer = `${ctx.pointer}/content/${escapePointer(mediaType)}`;
    const encoding = parseEncoding(media['encoding']);
    return {
      mediaType,
      kind: classifyMediaType(mediaType),
      schema: parseSchema(media['schema'], { ...ctx, pointer: `${pointer}/schema` }),
      ...(encoding && { encoding }),
    };
  });
}

function parseEncoding(raw: unknown): IRMediaType['encoding'] {
  if (!isRecord(raw)) return undefined;
  const out = new Map<string, { contentType?: string; style?: string; explode?: boolean }>();
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out.set(name, {
      ...(typeof value['contentType'] === 'string' && { contentType: value['contentType'] }),
      ...(typeof value['style'] === 'string' && { style: value['style'] }),
      ...(typeof value['explode'] === 'boolean' && { explode: value['explode'] }),
    });
  }
  return out.size > 0 ? out : undefined;
}

function classifyMediaType(mediaType: string): IRMediaType['kind'] {
  const type = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type.startsWith('multipart/')) return 'multipart';
  if (type.startsWith('text/')) return 'text';
  return 'binary';
}

// ---------------------------------------------------------------------------
// security / servers

function parseSecurityRequirements(raw: unknown): IRSecurityRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((req) => ({
    schemes: Object.entries(req).map(([name, scopes]) => ({ name, scopes: stringArray(scopes) })),
  }));
}

export function parseSecuritySchemes(doc: OpenAPIDocument, diagnostics: Diagnostics): Map<string, IRSecurityScheme> {
  const out = new Map<string, IRSecurityScheme>();
  const schemes: unknown = doc['components']?.['securitySchemes'];
  if (!isRecord(schemes)) return out;

  for (const [name, raw] of Object.entries(schemes)) {
    const pointer = `#/components/securitySchemes/${escapePointer(name)}`;
    const node = deref(raw, { doc, diagnostics, pointer, version: '3.1' });
    out.set(name, parseSecurityScheme(node, name, diagnostics, pointer));
  }
  return out;
}

function parseSecurityScheme(node: Obj, name: string, diagnostics: Diagnostics, pointer: string): IRSecurityScheme {
  switch (node['type']) {
    case 'http': {
      const scheme = typeof node['scheme'] === 'string' ? node['scheme'] : '';
      const lower = scheme.toLowerCase();
      if (lower === 'bearer') {
        return { kind: 'http-bearer', ...(typeof node['bearerFormat'] === 'string' && { bearerFormat: node['bearerFormat'] }) };
      }
      if (lower === 'basic') return { kind: 'http-basic' };
      diagnostics.warn('unsupported-auth', `HTTP auth scheme "${scheme}" of "${name}" is not supported`, pointer);
      return { kind: 'http-other', scheme };
    }
    case 'apiKey': {
      const location = node['in'];
      if ((location !== 'header' && location !== 'query' && location !== 'cookie') || typeof node['name'] !== 'string') {
        return diagnostics.error('invalid-security-scheme', `apiKey scheme "${name}" needs a valid "in" and "name"`, pointer);
      }
      return { kind: 'apiKey', in: location, name: node['name'] };
    }
    case 'oauth2':
      return { kind: 'oauth2', flows: parseOAuthFlows(node['flows']) };
    case 'openIdConnect':
      return { kind: 'openIdConnect', url: typeof node['openIdConnectUrl'] === 'string' ? node['openIdConnectUrl'] : '' };
    case 'mutualTLS':
      diagnostics.warn('unsupported-auth', `Security scheme "${name}" (mutualTLS) is not supported`, pointer);
      return { kind: 'mutualTLS' };
    default:
      return diagnostics.error('invalid-security-scheme', `Security scheme "${name}" has an unknown type`, pointer);
  }
}

function parseOAuthFlows(raw: unknown): IROAuthFlows {
  const flows: IROAuthFlows = {};
  if (!isRecord(raw)) return flows;
  for (const key of ['clientCredentials', 'authorizationCode', 'implicit', 'password'] as const) {
    const flow = raw[key];
    if (!isRecord(flow)) continue;
    const out: IROAuthFlow = {
      ...(typeof flow['authorizationUrl'] === 'string' && { authorizationUrl: flow['authorizationUrl'] }),
      ...(typeof flow['tokenUrl'] === 'string' && { tokenUrl: flow['tokenUrl'] }),
      ...(typeof flow['refreshUrl'] === 'string' && { refreshUrl: flow['refreshUrl'] }),
      scopes: isRecord(flow['scopes']) ? stringRecord(flow['scopes']) : {},
    };
    flows[key] = out;
  }
  return flows;
}

export function parseServers(raw: unknown): IRServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((s) => {
    const variables: IRServer['variables'] = {};
    if (isRecord(s['variables'])) {
      for (const [name, v] of Object.entries(s['variables'])) {
        if (!isRecord(v)) continue;
        const values = Array.isArray(v['enum']) ? v['enum'].filter((e): e is string => typeof e === 'string') : undefined;
        variables[name] = { default: String(v['default'] ?? ''), ...(values && { enum: values }) };
      }
    }
    return {
      url: typeof s['url'] === 'string' ? s['url'] : '/',
      ...(typeof s['description'] === 'string' && { description: s['description'] }),
      variables,
    };
  });
}

// ---------------------------------------------------------------------------
// helpers

/** ローカル `$ref` を辿って実体を返す。 */
function deref(raw: unknown, ctx: SchemaContext): Obj {
  let node = raw;
  const seen = new Set<string>();
  while (isRecord(node) && typeof node['$ref'] === 'string') {
    const ref = node['$ref'];
    if (!ref.startsWith('#/')) {
      return ctx.diagnostics.error('unsupported-ref', `Unsupported $ref "${ref}": only local references are supported`, ctx.pointer);
    }
    if (seen.has(ref)) return ctx.diagnostics.error('unsupported-ref', `Circular $ref "${ref}"`, ctx.pointer);
    seen.add(ref);
    node = resolvePointer(ctx.doc, ref);
    if (node === undefined) return ctx.diagnostics.error('broken-ref', `Cannot resolve $ref "${ref}"`, ctx.pointer);
  }
  return isRecord(node) ? node : {};
}

function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function stringRecord(v: Obj): Record<string, string> {
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
