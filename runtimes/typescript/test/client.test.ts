import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type ClientConfig } from '../src/client.js';
import { ApiError, TransportError } from '../src/errors.js';
import type { FetchLike } from '../src/transport.js';
import type { Middleware, OperationSpec } from '../src/types.js';

const calls = vi.hoisted(() => [] as string[]);

// Wrap the real auth middleware so the test can observe where it runs in the chain.
vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...actual,
    createAuthMiddleware: (getConfig: () => ClientConfig<any>): Middleware => {
      const inner = actual.createAuthMiddleware(getConfig);
      return (req, next, ctx) => {
        calls.push('auth');
        return inner(req, next, ctx);
      };
    },
  };
});

beforeEach(() => {
  calls.length = 0;
});

type Captured = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const captured: Captured[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = String(input);
    captured.push({ url, init });
    return respond(url, init);
  };
  return { fetch, captured };
}

function op(overrides: Partial<OperationSpec> = {}): OperationSpec {
  return {
    operationName: 'getThing',
    method: 'GET',
    path: '/things',
    tags: [],
    security: [],
    params: [],
    responses: { '200': 'json' },
    ...overrides,
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('createClient', () => {
  it('builds URL with path, query and preserves baseUrl path', async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const client = createClient({ baseUrl: 'https://x.test/api/', securitySchemes: {}, fetch });
    await client.request(
      op({
        path: '/foo/{id}',
        params: [
          { name: 'id', in: 'path', style: 'simple', explode: false },
          { name: 'q', in: 'query', style: 'form', explode: true },
          { name: 'tags', in: 'query', style: 'form', explode: true },
        ],
      }),
      { path: { id: 1 }, query: { q: 'a b', tags: ['x', 'y'] } },
    );
    expect(captured[0]?.url).toBe('https://x.test/api/foo/1?q=a%20b&tags=x&tags=y');
  });

  it('joins baseUrl without trailing slash and keeps it when options.baseUrl overrides', async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const client = createClient({ baseUrl: 'https://x.test/api', securitySchemes: {}, fetch });
    await client.request(op({ path: '/foo' }));
    await client.request(op({ path: '/foo' }), { baseUrl: 'https://y.test/v2/' });
    expect(captured.map((c) => c.url)).toEqual(['https://x.test/api/foo', 'https://y.test/v2/foo']);
  });

  it('builds headers from config, params, extra headers, cookies, body and Accept', async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const client = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {},
      fetch,
      headers: { 'X-Global': 'g', 'X-Trace': 'config' },
    });
    await client.request(
      op({
        method: 'POST',
        params: [
          { name: 'X-Trace', in: 'header', style: 'simple', explode: false },
          { name: 'session', in: 'cookie', style: 'form', explode: true },
        ],
        body: { kind: 'json', mediaType: 'application/json' },
      }),
      {
        headers: { 'X-Trace': ['a', 'b'], 'X-Extra': 5, 'X-None': undefined },
        cookies: { session: 'abc' },
        body: { a: 1 },
      },
    );
    const init = captured[0]!.init;
    const headers = init.headers as Headers;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(headers.get('x-global')).toBe('g');
    expect(headers.get('x-trace')).toBe('a,b');
    expect(headers.get('x-extra')).toBe('5');
    expect(headers.has('x-none')).toBe(false);
    expect(headers.get('cookie')).toBe('session=abc');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('uses */* Accept when no response is json and does not set Content-Type for multipart', async () => {
    const { fetch, captured } = fakeFetch(() => new Response('ok'));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    await client.request(
      op({ method: 'POST', responses: { '200': 'text' }, body: { kind: 'multipart', mediaType: 'multipart/form-data' } }),
      { body: { a: 'b' } },
    );
    const headers = captured[0]!.init.headers as Headers;
    expect(headers.get('accept')).toBe('*/*');
    expect(headers.has('content-type')).toBe(false);
    expect(captured[0]!.init.body).toBeInstanceOf(FormData);
  });

  it('returns {data,error:undefined} on 2xx', async () => {
    const { fetch } = fakeFetch(() => json({ id: 1 }));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    const result = await client.request<{ id: number }, unknown>(op());
    expect(result.data).toEqual({ id: 1 });
    expect(result.error).toBeUndefined();
    expect(result.response.status).toBe(200);
  });

  it('returns ApiError on 4xx with parsed body when throwOnError=false', async () => {
    const { fetch } = fakeFetch(() => json({ code: 'nope' }, 404));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    const result = await client.request<unknown, { code: string }>(op({ responses: { '200': 'json', '404': 'json' } }));
    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error?.status).toBe(404);
    expect(result.error?.body).toEqual({ code: 'nope' });
    expect(result.response.status).toBe(404);
  });

  it('falls back to raw text for undecodable error bodies and uses NXX/default kinds', async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith('/a') ? new Response('<html>bad gateway</html>', { status: 502 }) : json({ e: 1 }, 418),
    );
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    const a = await client.request(op({ path: '/a', responses: { '5XX': 'json' } }));
    expect(a.error?.body).toBe('<html>bad gateway</html>');
    const b = await client.request(op({ path: '/b', responses: { default: 'json' } }));
    expect(b.error?.body).toEqual({ e: 1 });
  });

  it('throws ApiError when throwOnError=true', async () => {
    const { fetch } = fakeFetch(() => json({ code: 'bad' }, 400));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    await expect(client.request(op(), { throwOnError: true })).rejects.toBeInstanceOf(ApiError);

    const throwing = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch, throwOnError: true });
    await expect(throwing.request(op({ responses: { '400': 'json' } }))).rejects.toMatchObject({
      status: 400,
      body: { code: 'bad' },
    });
    const overridden = await throwing.request(op(), { throwOnError: false });
    expect(overridden.error).toBeInstanceOf(ApiError);
  });

  it('throws TransportError on fetch rejection and timeout', async () => {
    const failing = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {},
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await failing.request(op()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).timedOut).toBe(false);
    expect((error as TransportError).cause).toBeInstanceOf(TypeError);

    const hanging = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {},
      timeout: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const timeout = await hanging.request(op()).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(TransportError);
    expect((timeout as TransportError).timedOut).toBe(true);
  });

  it('throws TransportError when the caller aborts', async () => {
    const controller = new AbortController();
    const client = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {},
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          controller.abort();
        }),
    });
    const error = await client.request(op(), { signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).timedOut).toBe(false);
  });

  it('runs middleware in registration order outer-to-inner, auth innermost', async () => {
    const recorder =
      (name: string): Middleware =>
      async (req, next) => {
        calls.push(`${name}:before`);
        const res = await next(req);
        calls.push(`${name}:after`);
        return res;
      };
    const { fetch } = fakeFetch(() => json({}));
    const client = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {},
      fetch,
      middleware: [recorder('mw1'), recorder('mw2')],
    });
    await client.request(op());
    expect(calls).toEqual(['mw1:before', 'mw2:before', 'auth', 'mw2:after', 'mw1:after']);
  });

  it('passes a populated CallContext to middleware', async () => {
    const seen: unknown[] = [];
    const { fetch } = fakeFetch(() => json({}));
    const client = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: {
        key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        q: { type: 'apiKey', in: 'query', name: 'api_key' },
      },
      fetch,
      middleware: [
        (req, next, ctx) => {
          seen.push(ctx);
          return next(req);
        },
      ],
    });
    await client.request(op({ tags: ['t'], security: [[{ scheme: 'key', scopes: [] }]] }), {
      extensions: { trace: 1 },
    });
    expect(seen[0]).toMatchObject({
      operationName: 'getThing',
      method: 'GET',
      pathTemplate: '/things',
      tags: ['t'],
      security: [[{ scheme: 'key', scopes: [] }]],
      attempt: 1,
      redact: { headers: ['x-api-key'], query: ['api_key'] },
      extensions: { trace: 1 },
    });
  });

  it('client.use appends middleware', async () => {
    const order: string[] = [];
    const tag =
      (name: string): Middleware =>
      (req, next) => {
        order.push(name);
        return next(req);
      };
    const { fetch } = fakeFetch(() => json({}));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch, middleware: [tag('a')] });
    client.use(tag('b'), tag('c'));
    await client.request(op());
    expect(order).toEqual(['a', 'b', 'c']);
    expect(client.getConfig().middleware).toHaveLength(3);
  });

  it('setConfig merges into the current config', async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    client.setConfig({ baseUrl: 'https://y.test/v1' });
    await client.request(op());
    expect(captured[0]?.url).toBe('https://y.test/v1/things');
    expect(client.getConfig().fetch).toBe(fetch);
  });

  it('handles 204 and empty 200 as undefined data', async () => {
    const { fetch } = fakeFetch((url) => (url.endsWith('/none') ? new Response(null, { status: 204 }) : new Response('')));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    const noContent = await client.request(op({ path: '/none', responses: { '204': 'empty' } }));
    expect(noContent.data).toBeUndefined();
    expect(noContent.error).toBeUndefined();
    const empty = await client.request(op({ path: '/empty' }));
    expect(empty.data).toBeUndefined();
    expect(empty.error).toBeUndefined();
  });

  it('applies op.transform to data', async () => {
    const { fetch } = fakeFetch(() => json({ at: '2024-01-01T00:00:00.000Z' }));
    const client = createClient({ baseUrl: 'https://x.test', securitySchemes: {}, fetch });
    const result = await client.request<{ at: Date }, unknown>(
      op({ transform: (data) => ({ at: new Date((data as { at: string }).at) }) }),
    );
    expect(result.data?.at).toBeInstanceOf(Date);
  });
});
