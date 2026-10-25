import { describe, expect, it } from 'vitest';
import {
  authBearer,
  createApiClient,
  echoHeadersCookies,
  flaky,
  loggingMiddleware,
  retry401Middleware,
  retryMiddleware,
  userAgentMiddleware,
  type Middleware,
} from '../generated/default/index.js';
import { baseUrl } from './support.js';

const headerParams = { headers: { 'X-Request-Ids': ['r1'] }, cookies: { theme: 'dark' } };

describe('middleware', () => {
  it('retries 503 responses until the endpoint succeeds', async () => {
    const client = createApiClient({ baseUrl, middleware: [retryMiddleware()] });
    const key = `retry-${Date.now()}`;
    const { data, response } = await flaky({ client, path: { key }, query: { fail: 2 } });
    expect(response.status).toBe(200);
    expect(data).toEqual({ key, attempts: 3 });
  });

  it('gives up after maxAttempts and returns the typed 503', async () => {
    const client = createApiClient({ baseUrl, middleware: [retryMiddleware({ maxAttempts: 2 })] });
    const { error, response } = await flaky({ client, path: { key: `give-up-${Date.now()}` }, query: { fail: 5 } });
    expect(response.status).toBe(503);
    expect(error!.body).toEqual({ code: 503, message: expect.any(String) });
  });

  it('re-sends once after a 401 when the token was swapped by retry401', async () => {
    let token = 'expired-token';
    const swaps: number[] = [];
    const client = createApiClient({
      baseUrl,
      auth: { bearerAuth: () => token },
      middleware: [
        retry401Middleware({
          onUnauthorized: (ctx) => {
            swaps.push(ctx.attempt);
            token = 'test-token';
            return true;
          },
        }),
      ],
    });
    const { data, response } = await authBearer({ client });
    expect(response.status).toBe(200);
    expect(data!.headers['authorization']).toBe('Bearer test-token');
    expect(swaps).toEqual([1]);
  });

  it('masks credentials in logs', async () => {
    const lines: unknown[][] = [];
    const record = (...args: unknown[]) => void lines.push(args);
    const logger = { debug: record, info: record, warn: record, error: record };
    // Credentials the logging middleware can see: auth itself is applied innermost, after logging.
    const withQueryKey: Middleware = (req, next) => {
      req.url.searchParams.set('api_key', 'test-key');
      return next(req);
    };
    const client = createApiClient({
      baseUrl,
      headers: { Authorization: 'Bearer test-token', 'X-API-Key': 'test-key' },
      middleware: [withQueryKey, loggingMiddleware({ logger, level: 'debug' })],
    });
    const { data } = await echoHeadersCookies({ client, throwOnError: true, ...headerParams });
    // The server did receive the credentials...
    expect(data.headers['authorization']).toBe('Bearer test-token');
    expect(data.headers['x-api-key']).toBe('test-key');
    expect(data.query).toBe('api_key=test-key');

    // ...but the log did not.
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('test-token');
    expect(logged).not.toContain('test-key');
    expect(logged).not.toContain('dark');
    const [line, headers] = lines[0] as [string, Record<string, string>];
    expect(line).toBe(`→ GET ${baseUrl}/echo/headers?api_key=***`);
    expect(headers).toMatchObject({ authorization: '***', 'x-api-key': '***', cookie: '***', 'x-request-ids': 'r1' });
    expect(lines[1]![0]).toMatch(/^← 200 \(\d+ms\)$/);
  });

  it('sets the User-Agent', async () => {
    const client = createApiClient({ baseUrl, middleware: [userAgentMiddleware('archon-e2e/1.0')] });
    const { data } = await echoHeadersCookies({ client, throwOnError: true, ...headerParams });
    expect(data.headers['user-agent']).toBe('archon-e2e/1.0');
  });

  it('runs middleware in registration order (config first, then use())', async () => {
    const order: string[] = [];
    const tag =
      (name: string): Middleware =>
      async (req, next) => {
        order.push(`>${name}`);
        req.headers.set('X-Trace', [req.headers.get('X-Trace'), name].filter(Boolean).join(','));
        const response = await next(req);
        order.push(`<${name}`);
        return response;
      };
    const client = createApiClient({ baseUrl, middleware: [tag('a'), tag('b')] });
    client.use(tag('c'));
    const { data } = await echoHeadersCookies({ client, throwOnError: true, ...headerParams });
    expect(data.headers['x-trace']).toBe('a,b,c');
    expect(order).toEqual(['>a', '>b', '>c', '<c', '<b', '<a']);
  });
});
