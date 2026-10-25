import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import { parseDocument, type ParserHooks } from '../../src/parser/index.js';

function parse(doc: Record<string, unknown>, hooks?: ParserHooks) {
  const diagnostics = new Diagnostics();
  const full = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {}, ...doc } as OpenAPIDocument;
  const ir = parseDocument(full, hooks ? { diagnostics, hooks } : { diagnostics });
  return { ir, diagnostics };
}

const ok = { '200': { description: 'ok' } };

describe('parameters', () => {
  test('merges path-level and operation-level parameters with operation precedence', () => {
    const { ir } = parse({
      components: { parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } } },
      paths: {
        '/foo/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'x', in: 'header', schema: { type: 'string' } },
            { $ref: '#/components/parameters/Limit' },
          ],
          get: {
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'x', in: 'query', schema: { type: 'string' } },
            ],
            responses: ok,
          },
        },
      },
    });
    const params = ir.operations[0]?.parameters.map((p) => [p.name, p.in, p.schema.kind, p.schema.origin]);
    expect(params).toEqual([
      ['id', 'path', 'integer', '#/paths/~1foo~1{id}/get/parameters/0/schema'],
      ['x', 'header', 'string', '#/paths/~1foo~1{id}/parameters/1/schema'],
      ['limit', 'query', 'integer', '#/paths/~1foo~1{id}/parameters/2/schema'],
      ['x', 'query', 'string', '#/paths/~1foo~1{id}/get/parameters/1/schema'],
    ]);
  });

  test('applies default style and explode per location', () => {
    const { ir } = parse({
      paths: {
        '/p/{a}': {
          get: {
            parameters: [
              { name: 'a', in: 'path', schema: { type: 'string' } },
              { name: 'b', in: 'query', schema: { type: 'string' } },
              { name: 'c', in: 'header', schema: { type: 'string' } },
              { name: 'd', in: 'cookie', schema: { type: 'string' } },
              { name: 'e', in: 'query', style: 'pipeDelimited', schema: { type: 'array', items: { type: 'string' } } },
              { name: 'f', in: 'query', style: 'form', explode: false, allowReserved: true, deprecated: true, schema: { type: 'string' } },
              { name: 'g', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
            ],
            responses: ok,
          },
        },
      },
    });
    const by = Object.fromEntries((ir.operations[0]?.parameters ?? []).map((p) => [p.name, p]));
    expect(by['a']).toMatchObject({ required: true, style: 'simple', explode: false, allowReserved: false, deprecated: false });
    expect(by['b']).toMatchObject({ required: false, style: 'form', explode: true });
    expect(by['c']).toMatchObject({ style: 'simple', explode: false });
    expect(by['d']).toMatchObject({ style: 'form', explode: true });
    expect(by['e']).toMatchObject({ style: 'pipeDelimited', explode: false });
    expect(by['f']).toMatchObject({ style: 'form', explode: false, allowReserved: true, deprecated: true });
    expect(by['g']).toMatchObject({ style: 'form', explode: true });
    expect(by['g']?.schema.kind).toBe('object');
  });
});

describe('request bodies', () => {
  test('sorts request body contents by priority and logs ignored alternatives', () => {
    const { ir, diagnostics } = parse({
      components: {
        requestBodies: {
          Body: {
            required: true,
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              'text/plain': { schema: { type: 'string' } },
              'application/x-www-form-urlencoded': { schema: { type: 'object' } },
              'multipart/form-data': { schema: { type: 'object' } },
              'application/vnd.api+json': { schema: { type: 'object' } },
            },
          },
        },
      },
      paths: { '/b': { post: { requestBody: { $ref: '#/components/requestBodies/Body' }, responses: ok } } },
    });
    const body = ir.operations[0]?.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.contents.map((c) => [c.mediaType, c.kind])).toEqual([
      ['application/vnd.api+json', 'json'],
      ['multipart/form-data', 'multipart'],
      ['application/x-www-form-urlencoded', 'form'],
      ['text/plain', 'text'],
      ['application/octet-stream', 'binary'],
    ]);
    const ignored = diagnostics.entries.filter((e) => e.code === 'request-body-alternative-ignored');
    expect(ignored).toHaveLength(4);
    expect(ignored.every((e) => e.level === 'info')).toBe(true);
  });

  test('parses encoding of multipart request body into IRMediaType.encoding', () => {
    const { ir } = parse({
      paths: {
        '/up': {
          post: {
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, meta: { type: 'object' } } },
                  encoding: {
                    file: { contentType: 'image/png, image/jpeg' },
                    meta: { contentType: 'application/json', style: 'form', explode: false },
                  },
                },
              },
            },
            responses: ok,
          },
        },
      },
    });
    const media = ir.operations[0]?.requestBody?.contents[0];
    expect(media?.kind).toBe('multipart');
    expect(media?.encoding).toEqual(
      new Map([
        ['file', { contentType: 'image/png, image/jpeg' }],
        ['meta', { contentType: 'application/json', style: 'form', explode: false }],
      ]),
    );
  });
});

describe('responses', () => {
  test('normalizes status keys, expands refs and headers', () => {
    const { ir } = parse({
      components: {
        headers: { RateLimit: { description: 'limit', schema: { type: 'integer' } } },
        responses: {
          NotFound: { description: 'nf', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
      paths: {
        '/r': {
          get: {
            responses: {
              '200': { description: 'ok', headers: { 'X-Rate': { $ref: '#/components/headers/RateLimit' } }, content: { 'text/plain': { schema: { type: 'string' } } } },
              '204': { description: 'none' },
              '404': { $ref: '#/components/responses/NotFound' },
              '4xx': { description: 'client' },
              default: { description: 'err' },
            },
          },
        },
      },
    });
    const rs = ir.operations[0]?.responses ?? [];
    expect(rs.map((r) => r.status)).toEqual([200, 204, 404, '4XX', 'default']);
    expect(rs[0]?.headers.get('X-Rate')).toMatchObject({ kind: 'integer' });
    expect(rs[0]?.contents.map((c) => c.kind)).toEqual(['text']);
    expect(rs[1]?.contents).toEqual([]);
    expect(rs[2]?.description).toBe('nf');
    expect(rs[2]?.contents[0]?.kind).toBe('json');
  });
});

describe('security', () => {
  test('inherits root security and maps {} to optional requirement', () => {
    const { ir } = parse({
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'Bearer', bearerFormat: 'JWT' } } },
      paths: {
        '/inherit': { get: { responses: ok } },
        '/optional': { get: { security: [{ bearerAuth: [] }, {}], responses: ok } },
        '/none': { get: { security: [], responses: ok } },
        '/scoped': { get: { security: [{ oauth: ['a', 'b'], key: [] }], responses: ok } },
      },
    });
    const sec = Object.fromEntries(ir.operations.map((o) => [o.path, o.security]));
    expect(sec['/inherit']).toEqual([{ schemes: [{ name: 'bearerAuth', scopes: [] }] }]);
    expect(sec['/optional']).toEqual([{ schemes: [{ name: 'bearerAuth', scopes: [] }] }, { schemes: [] }]);
    expect(sec['/none']).toEqual([]);
    expect(sec['/scoped']).toEqual([
      {
        schemes: [
          { name: 'oauth', scopes: ['a', 'b'] },
          { name: 'key', scopes: [] },
        ],
      },
    ]);
    expect(ir.securitySchemes.get('bearerAuth')).toEqual({ kind: 'http-bearer', bearerFormat: 'JWT' });
  });

  test('is empty without operation or root security', () => {
    const { ir } = parse({ paths: { '/x': { get: { responses: ok } } } });
    expect(ir.operations[0]?.security).toEqual([]);
  });

  test('maps every security scheme type', () => {
    const { ir, diagnostics } = parse({
      components: {
        securitySchemes: {
          basic: { type: 'http', scheme: 'basic' },
          key: { type: 'apiKey', in: 'header', name: 'X-Key' },
          oauth: {
            type: 'oauth2',
            flows: {
              clientCredentials: { tokenUrl: 'https://a/token', scopes: { r: 'read' } },
              authorizationCode: { authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token', refreshUrl: 'https://a/refresh', scopes: {} },
            },
          },
          oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://a/.well-known' },
        },
      },
    });
    expect([...ir.securitySchemes.keys()]).toEqual(['basic', 'key', 'oauth', 'oidc']);
    expect(ir.securitySchemes.get('basic')).toEqual({ kind: 'http-basic' });
    expect(ir.securitySchemes.get('key')).toEqual({ kind: 'apiKey', in: 'header', name: 'X-Key' });
    expect(ir.securitySchemes.get('oauth')).toEqual({
      kind: 'oauth2',
      flows: {
        clientCredentials: { tokenUrl: 'https://a/token', scopes: { r: 'read' } },
        authorizationCode: { authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token', refreshUrl: 'https://a/refresh', scopes: {} },
      },
    });
    expect(ir.securitySchemes.get('oidc')).toEqual({ kind: 'openIdConnect', url: 'https://a/.well-known' });
    expect(diagnostics.hasWarnings()).toBe(false);
  });

  test('warns unsupported-auth for digest and mutualTLS', () => {
    const { ir, diagnostics } = parse({
      components: { securitySchemes: { d: { type: 'http', scheme: 'digest' }, m: { type: 'mutualTLS' } } },
    });
    expect(ir.securitySchemes.get('d')).toEqual({ kind: 'http-other', scheme: 'digest' });
    expect(ir.securitySchemes.get('m')).toEqual({ kind: 'mutualTLS' });
    const warns = diagnostics.entries.filter((e) => e.code === 'unsupported-auth');
    expect(warns).toHaveLength(2);
    expect(warns.every((e) => e.level === 'warn')).toBe(true);
  });
});

describe('servers', () => {
  test('defaults to "/" and maps variables', () => {
    expect(parse({}).ir.servers).toEqual([{ url: '/', variables: {} }]);
    const { ir } = parse({
      servers: [
        { url: 'https://{env}.x.test', description: 'main', variables: { env: { default: 'prod', enum: ['prod', 'dev'] }, p: { default: '1' } } },
      ],
      paths: {
        '/a': { servers: [{ url: 'https://path.test' }], get: { responses: ok }, post: { servers: [{ url: 'https://op.test' }], responses: ok } },
      },
    });
    expect(ir.servers).toEqual([
      { url: 'https://{env}.x.test', description: 'main', variables: { env: { default: 'prod', enum: ['prod', 'dev'] }, p: { default: '1' } } },
    ]);
    expect(ir.operations[0]?.servers).toEqual([{ url: 'https://path.test', variables: {} }]);
    expect(ir.operations[1]?.servers).toEqual([{ url: 'https://op.test', variables: {} }]);
  });
});

describe('operation naming and grouping', () => {
  test('uses camelCased operationId, then derived name', () => {
    const { ir } = parse({
      paths: { '/a': { get: { operationId: 'list_all-things', responses: ok }, post: { responses: ok } } },
    });
    expect(ir.operations.map((o) => [o.id, o.name])).toEqual([
      ['GET /a', 'listAllThings'],
      ['POST /a', 'postA'],
    ]);
  });

  test('suffixes duplicate derived operation names', () => {
    const { ir, diagnostics } = parse({
      paths: { '/foo/{id}': { get: { responses: ok } }, '/foo/by/id': { get: { responses: ok } } },
    });
    expect(ir.operations.map((o) => o.name)).toEqual(['getFooById', 'getFooById2']);
    const renamed = diagnostics.entries.filter((e) => e.code === 'operation-renamed');
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.level).toBe('info');
  });

  test('uses operationName hook result', () => {
    const seen: string[] = [];
    const { ir } = parse(
      { paths: { '/a': { get: { operationId: 'x', responses: ok }, post: { responses: ok } } } },
      {
        operationName: (op, ctx) => {
          seen.push(`${op.name}|${ctx.derived}`);
          return op.method === 'get' ? 'custom' : undefined;
        },
      },
    );
    expect(ir.operations.map((o) => o.name)).toEqual(['custom', 'postA']);
    expect(seen).toEqual(['x|getA', 'postA|postA']);
  });

  test('groups by hook, then first tag, then undefined', () => {
    const { ir } = parse(
      {
        paths: {
          '/a': { get: { tags: ['t1', 't2'], responses: ok }, post: { responses: ok }, put: { tags: ['t3'], responses: ok } },
        },
      },
      { operationGroup: (op) => (op.method === 'put' ? 'hooked' : undefined) },
    );
    expect(ir.operations.map((o) => o.group)).toEqual(['t1', 'hooked', undefined]);
    expect(ir.operations[0]?.tags).toEqual(['t1', 't2']);
  });

  test('keeps paths in document order and methods in canonical order', () => {
    const { ir } = parse({
      paths: {
        '/b': { patch: { responses: ok }, get: { responses: ok } },
        '/a': { delete: { responses: ok }, put: { responses: ok }, post: { responses: ok } },
      },
    });
    expect(ir.operations.map((o) => o.id)).toEqual(['GET /b', 'PATCH /b', 'PUT /a', 'POST /a', 'DELETE /a']);
  });

  test('carries summary, description and deprecated', () => {
    const { ir } = parse({
      paths: { '/a': { get: { summary: 's', description: 'd', deprecated: true, responses: ok } } },
    });
    expect(ir.operations[0]).toMatchObject({ summary: 's', description: 'd', deprecated: true });
  });
});

describe('document', () => {
  test('parses info and component schemas', () => {
    const { ir } = parse({
      info: { title: 'T', version: '2', description: 'D' },
      components: { schemas: { A: { type: 'string' } } },
    });
    expect(ir.info).toEqual({ title: 'T', version: '2', description: 'D' });
    expect([...ir.schemas.keys()]).toEqual(['A']);
  });

  test('parses natsuneko fixture', () => {
    const doc = JSON.parse(
      readFileSync(new URL('../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const diagnostics = new Diagnostics();
    const ir = parseDocument(doc, { diagnostics });
    expect(ir.operations).toHaveLength(199);
    expect(ir.operations.every((o) => o.group !== undefined)).toBe(true);
    expect(ir.operations.filter((o) => o.security.length === 0)).toHaveLength(12);
    const status = ir.operations.find((o) => o.id === 'GET /catalyst/v1/status/{id}');
    expect(status?.security).toEqual([{ schemes: [{ name: 'bearerAuth', scopes: [] }] }]);
    expect(ir.securitySchemes.get('bearerAuth')).toEqual({ kind: 'http-bearer' });
    expect(new Set(ir.operations.map((o) => o.name)).size).toBe(199);
  });
});

describe('review fixes', () => {
  test('allowReserved is only kept for query parameters', () => {
    const { ir } = parse({
      paths: {
        '/p/{a}': {
          get: {
            parameters: [
              { name: 'a', in: 'path', required: true, allowReserved: true, schema: { type: 'string' } },
              { name: 'q', in: 'query', allowReserved: true, schema: { type: 'string' } },
              { name: 'h', in: 'header', allowReserved: true, schema: { type: 'string' } },
              { name: 'c', in: 'cookie', allowReserved: true, schema: { type: 'string' } },
            ],
            responses: ok,
          },
        },
      },
    });
    expect(ir.operations[0]?.parameters.map((p) => [p.name, p.allowReserved])).toEqual([
      ['a', false],
      ['q', true],
      ['h', false],
      ['c', false],
    ]);
  });

  test('falls back to the derived name when the operationId camelCases to an empty string', () => {
    const { ir, diagnostics } = parse({
      paths: {
        '/foo/{id}': { get: { operationId: '日本語の操作', responses: ok } },
        '/bar': { post: { operationId: '!!!', responses: ok } },
      },
    });
    expect(ir.operations.map((o) => o.name)).toEqual(['getFooById', 'postBar']);
    const warns = diagnostics.entries.filter((d) => d.code === 'operation-name-fallback');
    expect(warns.map((d) => [d.level, d.pointer])).toEqual([
      ['warn', '#/paths/~1foo~1{id}/get'],
      ['warn', '#/paths/~1bar/post'],
    ]);
    expect(warns[0]?.message).toContain('日本語の操作');
  });

  test('warns when a security requirement names an undefined scheme', () => {
    const { ir, diagnostics } = parse({
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ ghost: [] }],
      paths: {
        '/a': { get: { responses: ok } },
        '/b': { get: { security: [{ bearer: [] }, { bearer: [], phantom: ['x'] }], responses: ok } },
      },
    });
    expect(ir.operations).toHaveLength(2);
    const warns = diagnostics.entries.filter((d) => d.code === 'unknown-security-scheme');
    expect(warns.map((d) => [d.level, d.pointer])).toEqual([
      ['warn', '#/paths/~1a/get'],
      ['warn', '#/paths/~1b/get'],
    ]);
    expect(warns[0]?.message).toContain('"ghost"');
    expect(warns[1]?.message).toContain('"phantom"');
  });
});
