import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransportError } from '../src/errors.js';
import { send, type FetchLike } from '../src/transport.js';
import type { ApiRequest, HttpMethod } from '../src/types.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function listen(handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

function echo(req: IncomingMessage, res: ServerResponse, body: string): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
}

let a: { server: Server; origin: string };
let b: { server: Server; origin: string };

beforeAll(async () => {
  b = await listen(echo);
  a = await listen((req, res, body) => {
    const redirect = (status: number, location: string) => {
      res.statusCode = status;
      res.setHeader('location', location);
      res.end();
    };
    if (req.url?.startsWith('/cross')) return redirect(302, `${b.origin}/echo?api_key=secret&keep=1`);
    if (req.url?.startsWith('/same')) return redirect(307, '/echo');
    if (req.url?.startsWith('/see-other')) return redirect(303, '/echo');
    if (req.url?.startsWith('/loop')) return redirect(302, '/loop');
    return echo(req, res, body);
  });
});

afterAll(async () => {
  await Promise.all([a, b].map(({ server }) => new Promise((resolve) => server.close(resolve))));
});

const realFetch: FetchLike = (input, init) => fetch(input, init);

function request(method: HttpMethod, url: string, headers: Record<string, string>, body: string | null = null): ApiRequest {
  return { method, url: new URL(url), headers: new Headers(headers), body, replayable: true };
}

const credentials = { credentialHeaders: ['x-api-key'], credentialQuery: ['api_key'] };

describe('send', () => {
  it('manual redirect strips api key header on cross-origin hop', async () => {
    const res = await send(
      request('GET', `${a.origin}/cross?api_key=secret`, {
        'X-API-Key': 'secret',
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'X-Other': 'kept',
      }),
      { fetch: realFetch, ...credentials },
    );
    const echoed = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(res.status).toBe(200);
    expect(echoed.url).toBe('/echo?keep=1');
    expect(echoed.headers['x-api-key']).toBeUndefined();
    expect(echoed.headers['authorization']).toBeUndefined();
    expect(echoed.headers['cookie']).toBeUndefined();
    expect(echoed.headers['x-other']).toBe('kept');
  });

  it('same-origin redirect keeps headers', async () => {
    const res = await send(
      request('POST', `${a.origin}/same`, { 'X-API-Key': 'secret', Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, 'payload'),
      { fetch: realFetch, ...credentials },
    );
    const echoed = (await res.json()) as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body).toBe('payload');
    expect(echoed.headers['x-api-key']).toBe('secret');
    expect(echoed.headers['authorization']).toBe('Bearer t');
  });

  it('303 converts to GET', async () => {
    const res = await send(
      request('POST', `${a.origin}/see-other`, { 'X-API-Key': 'secret', 'Content-Type': 'application/json' }, '{"a":1}'),
      { fetch: realFetch, ...credentials },
    );
    const echoed = (await res.json()) as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe('GET');
    expect(echoed.body).toBe('');
    expect(echoed.headers['content-type']).toBeUndefined();
    expect(echoed.headers['x-api-key']).toBe('secret');
  });

  it('throws TransportError after too many redirects', async () => {
    const error = await send(request('GET', `${a.origin}/loop`, { 'X-API-Key': 'secret' }), {
      fetch: realFetch,
      ...credentials,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
  });

  it('lets fetch follow redirects when no credentials are attached', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const res = await send(request('GET', `${a.origin}/cross`, { 'X-Other': '1' }), {
      fetch: (input, init) => {
        seen.push(init);
        return fetch(input, init);
      },
      ...credentials,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('follow');
  });
});
