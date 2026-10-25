import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { TransportError } from '../src/errors.js';
import {
  compose,
  loggingMiddleware,
  retry401Middleware,
  retryMiddleware,
  userAgentMiddleware,
  type Logger,
} from '../src/middleware.js';
import type { FetchLike } from '../src/transport.js';
import type { ApiRequest, CallContext, HttpMethod, Next, OperationSpec } from '../src/types.js';

function makeCtx(overrides: Partial<CallContext> = {}): CallContext {
  return {
    operationName: 'op',
    method: 'GET',
    pathTemplate: '/things',
    tags: [],
    security: [],
    attempt: 1,
    redact: { headers: [], query: [] },
    extensions: {},
    ...overrides,
  };
}

function makeReq(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'GET',
    url: new URL('https://x.test/things'),
    headers: new Headers(),
    body: null,
    replayable: true,
    ...overrides,
  };
}

const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

/** A `next` that serves the given outcomes in order (Response or Error to throw). */
function sequence(...outcomes: (Response | Error)[]) {
  const next = vi.fn<Next>(async () => {
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('sequence exhausted');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return next;
}

describe('compose', () => {
  it('runs the first middleware outermost', async () => {
    const order: string[] = [];
    const mw = (name: string) => async (req: ApiRequest, next: Next) => {
      order.push(`>${name}`);
      const r = await next(req);
      order.push(`<${name}`);
      return r;
    };
    const chain = compose([mw('a'), mw('b')], async () => res(200), makeCtx());
    await chain(makeReq());
    expect(order).toEqual(['>a', '>b', '<b', '<a']);
  });
});

describe('userAgentMiddleware', () => {
  it('sets the User-Agent header', async () => {
    const next = sequence(res(200));
    const req = makeReq();
    await userAgentMiddleware('archon-test/1.0')(req, next, makeCtx());
    expect(req.headers.get('user-agent')).toBe('archon-test/1.0');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('loggingMiddleware', () => {
  function logger() {
    const lines: { level: string; args: unknown[] }[] = [];
    const log = (level: string) => (...args: unknown[]) => lines.push({ level, args });
    const l: Logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
    return { l, lines };
  }

  it('logs request and response lines with duration', async () => {
    const { l, lines } = logger();
    const req = makeReq({ url: new URL('https://x.test/things?a=1') });
    await loggingMiddleware({ logger: l })(req, sequence(res(201)), makeCtx());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ level: 'info', args: ['→ GET https://x.test/things?a=1'] });
    expect(lines[1]?.level).toBe('info');
    expect(String(lines[1]?.args[0])).toMatch(/^← 201 \(\d+ms\)$/);
  });

  it('masks authorization and api key query', async () => {
    const { l, lines } = logger();
    const req = makeReq({
      url: new URL('https://x.test/things?API_KEY=secret&q=hello&token=t0k&x=1'),
      headers: new Headers({ Authorization: 'Bearer s3cr3t', 'X-Api-Key': 'k', 'X-Other': 'visible' }),
    });
    const ctx = makeCtx({ redact: { headers: ['x-api-key'], query: ['api_key'] } });
    await loggingMiddleware({ logger: l, level: 'debug', redactQuery: ['Token'] })(req, sequence(res(200)), ctx);

    const text = JSON.stringify(lines);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('s3cr3t');
    expect(text).not.toContain('t0k');
    expect(lines[0]?.args[0]).toBe('→ GET https://x.test/things?API_KEY=***&q=hello&token=***&x=1');
    expect(lines[0]?.level).toBe('debug');
    expect(lines[0]?.args[1]).toEqual({ authorization: '***', 'x-api-key': '***', 'x-other': 'visible' });
    // The request itself is never mutated.
    expect(req.url.toString()).toContain('API_KEY=secret');
    expect(req.headers.get('authorization')).toBe('Bearer s3cr3t');
  });

  it('masks default sensitive headers and opts.redactHeaders at debug level', async () => {
    const { l, lines } = logger();
    const req = makeReq({
      headers: new Headers({ Cookie: 'a=b', 'Proxy-Authorization': 'p', 'X-Custom': 'c', Accept: 'application/json' }),
    });
    await loggingMiddleware({ logger: l, level: 'debug', redactHeaders: ['X-Custom'] })(req, sequence(res(200)), makeCtx());
    expect(lines[0]?.args[1]).toEqual({
      cookie: '***',
      'proxy-authorization': '***',
      'x-custom': '***',
      accept: 'application/json',
    });
  });

  it('does not log headers at info level', async () => {
    const { l, lines } = logger();
    const req = makeReq({ headers: new Headers({ Authorization: 'Bearer x' }) });
    await loggingMiddleware({ logger: l })(req, sequence(res(200)), makeCtx());
    expect(lines[0]?.args).toHaveLength(1);
  });
});

describe('retryMiddleware', () => {
  const noJitter = { random: () => 1 };

  it('retries 503 with Retry-After seconds then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const next = sequence(res(503, { 'Retry-After': '1' }), res(200));
    const ctx = makeCtx();
    const r = await retryMiddleware({ sleep })(makeReq(), next, ctx);
    expect(r.status).toBe(200);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
    expect(next).toHaveBeenCalledTimes(2);
    expect(ctx.attempt).toBe(2);
  });

  it('caps Retry-After at maxRetryAfterMs', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await retryMiddleware({ sleep, maxRetryAfterMs: 2500 })(
      makeReq(),
      sequence(res(429, { 'Retry-After': '120' }), res(200)),
      makeCtx(),
    );
    expect(sleep).toHaveBeenCalledWith(2500);
  });

  it('honours a Retry-After HTTP-date', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const sleep = vi.fn(async (_ms: number) => {});
      const when = new Date('2030-01-01T00:00:03Z').toUTCString();
      await retryMiddleware({ sleep })(makeReq(), sequence(res(503, { 'Retry-After': when }), res(200)), makeCtx());
      expect(sleep).toHaveBeenCalledWith(3000);

      const past = new Date('2029-12-31T00:00:00Z').toUTCString();
      await retryMiddleware({ sleep })(makeReq(), sequence(res(429, { 'Retry-After': past }), res(200)), makeCtx());
      expect(sleep).toHaveBeenLastCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores Retry-After on statuses other than 429 and 503', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await retryMiddleware({ sleep, ...noJitter })(
      makeReq(),
      sequence(res(500, { 'Retry-After': '30' }), res(200)),
      makeCtx(),
    );
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('falls back to backoff when Retry-After is unparseable', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await retryMiddleware({ sleep, ...noJitter })(
      makeReq(),
      sequence(res(503, { 'Retry-After': 'soon' }), res(200)),
      makeCtx(),
    );
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it.each(['1.5', '-5', '0.5'])('falls back to backoff for non-integer, non-date Retry-After %s', async (value) => {
    const sleep = vi.fn(async (_ms: number) => {});
    await retryMiddleware({ sleep, ...noJitter })(makeReq(), sequence(res(429, { 'Retry-After': value }), res(200)), makeCtx());
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('does not retry POST by default', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const next = sequence(res(503));
    const r = await retryMiddleware({ sleep })(makeReq({ method: 'POST' }), next, makeCtx({ method: 'POST' }));
    expect(r.status).toBe(503);
    expect(next).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries POST when methods includes it', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const methods: HttpMethod[] = ['POST'];
    const r = await retryMiddleware({ sleep, methods })(
      makeReq({ method: 'POST' }),
      sequence(res(503), res(200)),
      makeCtx({ method: 'POST' }),
    );
    expect(r.status).toBe(200);
  });

  it('does not retry non-replayable request', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const next = sequence(res(503));
    const r = await retryMiddleware({ sleep })(makeReq({ replayable: false }), next, makeCtx());
    expect(r.status).toBe(503);
    expect(next).toHaveBeenCalledOnce();

    const failing = sequence(new TransportError('boom'));
    await expect(retryMiddleware({ sleep })(makeReq({ replayable: false }), failing, makeCtx())).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledOnce();
  });

  it('does not retry statuses outside the list', async () => {
    const next = sequence(res(404));
    const r = await retryMiddleware({ sleep: async () => {} })(makeReq(), next, makeCtx());
    expect(r.status).toBe(404);
    expect(next).toHaveBeenCalledOnce();
  });

  it('stops after maxAttempts', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const next = sequence(res(500), res(500), res(500), res(200));
    const ctx = makeCtx();
    const r = await retryMiddleware({ sleep })(makeReq(), next, ctx);
    expect(r.status).toBe(500);
    expect(next).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(ctx.attempt).toBe(3);

    const next5 = sequence(res(500), res(500), res(500), res(500), res(500), res(200));
    await retryMiddleware({ sleep, maxAttempts: 5 })(makeReq(), next5, makeCtx());
    expect(next5).toHaveBeenCalledTimes(5);
  });

  it('cancels the discarded response body before retrying', async () => {
    const cancel = vi.fn(async () => {});
    const discarded = res(503);
    Object.defineProperty(discarded, 'body', { value: { cancel } });
    await retryMiddleware({ sleep: async () => {} })(makeReq(), sequence(discarded, res(200)), makeCtx());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('retries network errors', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const next = sequence(new TransportError('reset'), res(200));
    const r = await retryMiddleware({ sleep })(makeReq(), next, makeCtx());
    expect(r.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last network error when attempts are exhausted', async () => {
    const next = sequence(new TransportError('a'), new TransportError('b'), new TransportError('c'));
    await expect(retryMiddleware({ sleep: async () => {} })(makeReq(), next, makeCtx())).rejects.toThrow('c');
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('does not retry timeouts, caller aborts, other errors, or when retryOnNetworkError is false', async () => {
    const sleep = async () => {};
    const timedOut = sequence(new TransportError('t', { timedOut: true }));
    await expect(retryMiddleware({ sleep })(makeReq(), timedOut, makeCtx())).rejects.toThrow('t');
    expect(timedOut).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort();
    const aborted = sequence(new TransportError('aborted'));
    await expect(
      retryMiddleware({ sleep })(makeReq({ signal: controller.signal }), aborted, makeCtx({ signal: controller.signal })),
    ).rejects.toThrow('aborted');
    expect(aborted).toHaveBeenCalledOnce();

    const other = sequence(new TypeError('bug'));
    await expect(retryMiddleware({ sleep })(makeReq(), other, makeCtx())).rejects.toThrow('bug');
    expect(other).toHaveBeenCalledOnce();

    const disabled = sequence(new TransportError('reset'));
    await expect(retryMiddleware({ sleep, retryOnNetworkError: false })(makeReq(), disabled, makeCtx())).rejects.toThrow(
      'reset',
    );
    expect(disabled).toHaveBeenCalledOnce();
  });

  it('equal jitter delay bounds', async () => {
    const delays = async (random: () => number, opts: Parameters<typeof retryMiddleware>[0] = {}) => {
      const sleep = vi.fn(async (_ms: number) => {});
      await retryMiddleware({ sleep, random, maxAttempts: 4, ...opts })(
        makeReq(),
        sequence(res(500), res(500), res(500), res(200)),
        makeCtx(),
      );
      return sleep.mock.calls.map((c) => c[0]);
    };
    // min(max, base * 2^(n-1)) * (0.5 + random/2)
    expect(await delays(() => 0)).toEqual([100, 200, 400]);
    expect(await delays(() => 1)).toEqual([200, 400, 800]);
    expect(await delays(() => 0.5)).toEqual([150, 300, 600]);
    expect(await delays(() => 1, { maxDelayMs: 300 })).toEqual([200, 300, 300]);
    expect(await delays(() => 1, { baseDelayMs: 10 })).toEqual([10, 20, 40]);
  });

  it('default sleep waits and honours the abort signal', async () => {
    vi.useFakeTimers();
    try {
      const next = sequence(res(500), res(200));
      const pending = retryMiddleware({ random: () => 0, baseDelayMs: 1000 })(makeReq(), next, makeCtx());
      await vi.advanceTimersByTimeAsync(499);
      expect(next).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(200);

      const controller = new AbortController();
      const ctx = makeCtx({ signal: controller.signal });
      const aborting = retryMiddleware({ random: () => 0, baseDelayMs: 1000 })(
        makeReq({ signal: controller.signal }),
        sequence(res(500), res(200)),
        ctx,
      );
      const settled = aborting.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(100);
      controller.abort(new Error('stop'));
      const error = await settled;
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).cause).toEqual(new Error('stop'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retry401Middleware', () => {
  it('calls onUnauthorized and retries once', async () => {
    const onUnauthorized = vi.fn((_ctx: CallContext, _response: Response) => true);
    const next = sequence(res(401), res(200));
    const ctx = makeCtx();
    const r = await retry401Middleware({ onUnauthorized })(makeReq(), next, ctx);
    expect(r.status).toBe(200);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onUnauthorized.mock.calls[0]?.[0]).toBe(ctx);
    expect(ctx.attempt).toBe(2);

    const again = sequence(res(401), res(401), res(200));
    const second = await retry401Middleware({ onUnauthorized })(makeReq(), again, makeCtx());
    expect(second.status).toBe(401);
    expect(again).toHaveBeenCalledTimes(2);
  });

  it('cancels the 401 body when onUnauthorized throws', async () => {
    const cancel = vi.fn(async () => {});
    const unauthorized = res(401);
    Object.defineProperty(unauthorized, 'body', { value: { cancel } });
    const failure = new Error('refresh failed');
    await expect(
      retry401Middleware({
        onUnauthorized: async () => {
          throw failure;
        },
      })(makeReq(), sequence(unauthorized), makeCtx()),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not retry when onUnauthorized returns false or the request is not replayable', async () => {
    const denied = sequence(res(401));
    const r = await retry401Middleware({ onUnauthorized: async () => false })(makeReq(), denied, makeCtx());
    expect(r.status).toBe(401);
    expect(denied).toHaveBeenCalledOnce();

    const onUnauthorized = vi.fn(() => true);
    const stream = sequence(res(401));
    await retry401Middleware({ onUnauthorized })(makeReq({ replayable: false }), stream, makeCtx());
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledOnce();
  });

  it('retry401 calls onUnauthorized and retries once with fresh auth', async () => {
    let token = 'old-token';
    const seen: (string | null)[] = [];
    const fetch: FetchLike = async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      seen.push(authorization);
      return authorization === 'Bearer new-token' ? new Response('{}', { status: 200 }) : new Response('', { status: 401 });
    };
    const client = createClient({
      baseUrl: 'https://x.test',
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      auth: { bearer: () => token },
      fetch,
      middleware: [
        retry401Middleware({
          onUnauthorized: (ctx, response) => {
            expect(response.status).toBe(401);
            expect(ctx.operationName).toBe('getThing');
            token = 'new-token';
            return true;
          },
        }),
      ],
    });
    const op: OperationSpec = {
      operationName: 'getThing',
      method: 'GET',
      path: '/things',
      tags: [],
      security: [[{ scheme: 'bearer', scopes: [] }]],
      params: [],
      responses: { '200': 'json' },
    };
    const result = await client.request(op);
    expect(result.error).toBeUndefined();
    expect(seen).toEqual(['Bearer old-token', 'Bearer new-token']);
  });
});
