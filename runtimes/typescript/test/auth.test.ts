import { describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware, selectRequirement } from '../src/auth.js';
import type { ClientConfig } from '../src/client.js';
import { AuthError } from '../src/errors.js';
import type { FetchLike } from '../src/transport.js';
import type { ApiRequest, CallContext, Next, SecurityRequirement, SecuritySchemeSpec } from '../src/types.js';

describe('selectRequirement', () => {
  const bearer: SecurityRequirement = [{ scheme: 'bearer', scopes: [] }];

  it('is anonymous when there are no requirements', () => {
    expect(selectRequirement([], () => false)).toEqual({ kind: 'anonymous' });
  });

  it('applies the first alternative that is fully configured', () => {
    const second: SecurityRequirement = [{ scheme: 'key', scopes: [] }];
    expect(selectRequirement([bearer, second], (s) => s === 'key')).toEqual({ kind: 'apply', requirement: second });
    expect(selectRequirement([bearer, second], () => true)).toEqual({ kind: 'apply', requirement: bearer });
  });

  it('falls back to anonymous when an empty alternative exists and nothing else is satisfiable', () => {
    expect(selectRequirement([bearer, []], () => false)).toEqual({ kind: 'anonymous' });
  });

  it('prefers a configured scheme over an empty alternative', () => {
    expect(selectRequirement([[], bearer], () => true)).toEqual({ kind: 'apply', requirement: bearer });
  });

  it('is missing when a required scheme is not configured', () => {
    expect(selectRequirement([bearer], () => false)).toEqual({ kind: 'missing', schemes: ['bearer'] });
  });

  it('moves to the next alternative when an AND requirement is only partly configured', () => {
    const both: SecurityRequirement = [
      { scheme: 'a', scopes: [] },
      { scheme: 'b', scopes: [] },
    ];
    const onlyA: SecurityRequirement = [{ scheme: 'a', scopes: [] }];
    expect(selectRequirement([both, onlyA], (s) => s === 'a')).toEqual({ kind: 'apply', requirement: onlyA });
    expect(selectRequirement([both], (s) => s === 'a')).toEqual({ kind: 'missing', schemes: ['b'] });
  });

  it('reports the unconfigured schemes of the first non-empty requirement', () => {
    const first: SecurityRequirement = [
      { scheme: 'a', scopes: [] },
      { scheme: 'b', scopes: [] },
    ];
    const second: SecurityRequirement = [{ scheme: 'c', scopes: [] }];
    expect(selectRequirement([[], first, second], () => false)).toEqual({ kind: 'anonymous' });
    expect(selectRequirement([first, second], (s) => s === 'a')).toEqual({ kind: 'missing', schemes: ['b'] });
  });
});

const schemes: Record<string, SecuritySchemeSpec> = {
  bearer: { type: 'http', scheme: 'bearer' },
  basic: { type: 'http', scheme: 'basic' },
  keyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  keyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
  keyCookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
  oauth: { type: 'oauth2', tokenUrl: 'https://auth.test/token', refreshUrl: 'https://auth.test/refresh' },
  oidc: { type: 'openIdConnect' },
};

const req_ = (scheme: string, scopes: string[] = []): SecurityRequirement => [{ scheme, scopes }];

function makeReq(over: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'GET',
    url: new URL('https://api.test/things?x=1'),
    headers: new Headers(),
    body: null,
    replayable: true,
    ...over,
  };
}

function makeCtx(security: SecurityRequirement[]): CallContext {
  return {
    operationName: 'op',
    method: 'GET',
    pathTemplate: '/things',
    tags: [],
    security,
    attempt: 1,
    redact: { headers: [], query: [] },
    extensions: {},
  };
}

const ok = () => new Response('{}', { status: 200 });

function setup(config: Partial<ClientConfig<any>>, security: SecurityRequirement[]) {
  let current: ClientConfig<any> = { baseUrl: 'https://api.test', securitySchemes: schemes, ...config };
  const mw = createAuthMiddleware(() => current);
  const seen: ApiRequest[] = [];
  const next: Next = vi.fn(async (r: ApiRequest) => {
    seen.push({ ...r, headers: new Headers(r.headers), url: new URL(r.url) });
    return ok();
  });
  return {
    mw,
    next,
    seen,
    ctx: makeCtx(security),
    setConfig: (p: Partial<ClientConfig<any>>) => (current = { ...current, ...p }),
  };
}

describe('createAuthMiddleware', () => {
  it('applies bearer from async provider', async () => {
    const t = setup({ auth: { bearer: async () => 'tok' } }, [req_('bearer')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer tok');
  });

  it('applies bearer from a string', async () => {
    const t = setup({ auth: { bearer: 'abc' } }, [req_('bearer')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer abc');
  });

  it('applies basic', async () => {
    const t = setup({ auth: { basic: { username: 'user', password: 'päss' } } }, [req_('basic')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('authorization')).toBe('Basic dXNlcjpww6Rzcw==');
  });

  it('applies basic from a provider', async () => {
    const t = setup({ auth: { basic: async () => ({ username: 'a', password: 'b' }) } }, [req_('basic')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('authorization')).toBe('Basic YTpi');
  });

  it('applies apiKey in header', async () => {
    const t = setup({ auth: { keyHeader: 'k1' } }, [req_('keyHeader')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('x-api-key')).toBe('k1');
  });

  it('applies apiKey in query, keeping existing query bytes and replacing a same-named param', async () => {
    const t = setup({ auth: { keyQuery: 'k 2' } }, [req_('keyQuery')]);
    const req = makeReq({ url: new URL('https://api.test/things?a=1%2C2&api_key=old&b=x') });
    await t.mw(req, t.next, t.ctx);
    expect(t.seen[0]!.url.search).toBe('?a=1%2C2&b=x&api_key=k%202');
  });

  it('applies apiKey in query when there is no query yet', async () => {
    const t = setup({ auth: { keyQuery: 'k' } }, [req_('keyQuery')]);
    await t.mw(makeReq({ url: new URL('https://api.test/things') }), t.next, t.ctx);
    expect(t.seen[0]!.url.search).toBe('?api_key=k');
  });

  it('applies apiKey in cookie, appending to an existing Cookie header', async () => {
    const t = setup({ auth: { keyCookie: 'abc' } }, [req_('keyCookie')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('cookie')).toBe('sid=abc');

    const t2 = setup({ auth: { keyCookie: 'abc' } }, [req_('keyCookie')]);
    await t2.mw(makeReq({ headers: new Headers({ Cookie: 'a=1' }) }), t2.next, t2.ctx);
    expect(t2.seen[0]!.headers.get('cookie')).toBe('a=1; sid=abc');
  });

  it('percent-encodes the apiKey cookie value so it cannot inject cookie pairs', async () => {
    const t = setup({ auth: { keyCookie: 'a; admin=1,b' } }, [req_('keyCookie')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('cookie')).toBe('sid=a%3B%20admin%3D1%2Cb');
  });

  it('is idempotent for query and cookie keys on re-entry with the same request', async () => {
    const t = setup({ auth: { keyQuery: 'k', keyCookie: 'c' } }, [
      [
        { scheme: 'keyQuery', scopes: [] },
        { scheme: 'keyCookie', scopes: [] },
      ],
    ]);
    const req = makeReq({ headers: new Headers({ Cookie: 'a=1' }) });
    await t.mw(req, t.next, t.ctx);
    await t.mw(req, t.next, t.ctx);
    expect(t.seen[1]!.url.search).toBe('?x=1&api_key=k');
    expect(t.seen[1]!.headers.get('cookie')).toBe('a=1; sid=c');
  });

  it('applies every scheme of an AND requirement', async () => {
    const t = setup({ auth: { bearer: 'tok', keyHeader: 'k' } }, [
      [
        { scheme: 'bearer', scopes: [] },
        { scheme: 'keyHeader', scopes: [] },
      ],
    ]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(t.seen[0]!.headers.get('x-api-key')).toBe('k');
  });

  it('throws AuthError before sending when required auth missing', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ok());
    const t = setup({ auth: {}, fetch: fetchSpy }, [req_('bearer')]);
    const err = await t.mw(makeReq(), t.next, t.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).schemes).toEqual(['bearer']);
    expect(t.next).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a scheme absent from securitySchemes as not configured', async () => {
    const t = setup({ auth: { ghost: 'x' } }, [req_('ghost')]);
    await expect(t.mw(makeReq(), t.next, t.ctx)).rejects.toBeInstanceOf(AuthError);
  });

  it('sends anonymously when the operation has no security or accepts none', async () => {
    const t = setup({ auth: { bearer: 'tok' } }, []);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(t.seen[0]!.headers.has('authorization')).toBe(false);

    const t2 = setup({ auth: {} }, [req_('bearer'), []]);
    await t2.mw(makeReq(), t2.next, t2.ctx);
    expect(t2.seen[0]!.headers.has('authorization')).toBe(false);
  });

  it('re-applies fresh token on re-entry', async () => {
    let n = 0;
    const t = setup({ auth: { bearer: async () => `tok${++n}` } }, [req_('bearer')]);
    const req = makeReq();
    // an outer retry middleware calls the chain twice with the same request object
    await t.mw(req, t.next, t.ctx);
    await t.mw(req, t.next, t.ctx);
    expect(t.seen.map((r) => r.headers.get('authorization'))).toEqual(['Bearer tok1', 'Bearer tok2']);
  });

  it('calls customAuth last, after the schemes were applied', async () => {
    const customAuth = vi.fn((r: ApiRequest, _ctx: CallContext) => {
      r.headers.set('X-Signature', `sig(${r.headers.get('authorization')})`);
    });
    const t = setup({ auth: { bearer: 'tok' }, customAuth }, [req_('bearer')]);
    await t.mw(makeReq(), t.next, t.ctx);
    expect(customAuth).toHaveBeenCalledTimes(1);
    expect(customAuth.mock.calls[0]![1]).toBe(t.ctx);
    expect(t.seen[0]!.headers.get('x-signature')).toBe('sig(Bearer tok)');
  });

  it('does not call customAuth when auth is missing', async () => {
    const customAuth = vi.fn();
    const t = setup({ auth: {}, customAuth }, [req_('bearer')]);
    await expect(t.mw(makeReq(), t.next, t.ctx)).rejects.toBeInstanceOf(AuthError);
    expect(customAuth).not.toHaveBeenCalled();
  });

  describe('customAuth for schemes the generator does not support (digest, mutualTLS, ...)', () => {
    // The generated securitySchemes omit unsupported schemes, but operations still require them.
    const digestOnly: SecurityRequirement[] = [req_('digest')];

    it('treats a scheme missing from securitySchemes as configured when customAuth is set', async () => {
      const customAuth = vi.fn((r: ApiRequest) => {
        r.headers.set('Authorization', 'Digest username="u"');
      });
      const t = setup({ customAuth }, digestOnly);
      await t.mw(makeReq(), t.next, t.ctx);
      expect(customAuth).toHaveBeenCalledTimes(1);
      expect(t.seen[0]!.headers.get('authorization')).toBe('Digest username="u"');
    });

    it('still applies the supported schemes of an AND requirement alongside customAuth', async () => {
      const customAuth = vi.fn((r: ApiRequest) => {
        r.headers.set('X-Client-Cert', 'yes');
      });
      const t = setup({ auth: { keyHeader: 'k' }, customAuth }, [[...req_('keyHeader'), ...req_('mtls')]]);
      await t.mw(makeReq(), t.next, t.ctx);
      expect(t.seen[0]!.headers.get('x-api-key')).toBe('k');
      expect(t.seen[0]!.headers.get('x-client-cert')).toBe('yes');
    });

    it('throws AuthError for such a scheme without customAuth', async () => {
      const t = setup({}, digestOnly);
      await expect(t.mw(makeReq(), t.next, t.ctx)).rejects.toBeInstanceOf(AuthError);
      expect(t.next).not.toHaveBeenCalled();
    });
  });

  describe('oauth2', () => {
    function tokenServer(tokens: string[] = []) {
      const calls: { url: string; form: URLSearchParams }[] = [];
      const fetch: FetchLike = async (input, init) => {
        calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? '')) });
        const access = tokens[calls.length - 1] ?? `tok${calls.length}`;
        return new Response(JSON.stringify({ access_token: access, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      return { fetch, calls };
    }
    const cc = { clientId: 'id', clientSecret: 's' };

    it('uses accessToken when present, without touching the token endpoint', async () => {
      const server = tokenServer();
      const t = setup({ auth: { oauth: { accessToken: async () => 'direct', clientCredentials: cc } }, fetch: server.fetch }, [
        req_('oauth', ['read']),
      ]);
      await t.mw(makeReq(), t.next, t.ctx);
      expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer direct');
      expect(server.calls).toHaveLength(0);
    });

    it('fetches a token via client credentials using the requirement scopes and the spec tokenUrl', async () => {
      const server = tokenServer();
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth', ['b', 'a'])]);
      await t.mw(makeReq(), t.next, t.ctx);
      expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer tok1');
      expect(server.calls[0]!.url).toBe('https://auth.test/token');
      expect(server.calls[0]!.form.get('scope')).toBe('a b');
    });

    it('uses refreshUrl (falling back to tokenUrl) for the refresh flow', async () => {
      const server = tokenServer();
      const t = setup(
        { auth: { oauth: { refreshToken: { refreshToken: 'rt', clientId: 'id' } } }, fetch: server.fetch },
        [req_('oauth')],
      );
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls[0]!.url).toBe('https://auth.test/refresh');
    });

    it("resolves a relative spec tokenUrl / refreshUrl against the client's baseUrl", async () => {
      const relative: Record<string, SecuritySchemeSpec> = {
        cc: { type: 'oauth2', tokenUrl: '/oauth/token' },
        rt: { type: 'oauth2', tokenUrl: '/oauth/token', refreshUrl: 'oauth/refresh' },
      };
      const server = tokenServer();
      const t = setup(
        {
          baseUrl: 'http://h/api/',
          securitySchemes: relative,
          auth: { cc: { clientCredentials: cc }, rt: { refreshToken: { refreshToken: 'r', clientId: 'id' } } },
          fetch: server.fetch,
        },
        [[...req_('cc'), ...req_('rt')]],
      );
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls.map((c) => c.url)).toEqual(['http://h/oauth/token', 'http://h/api/oauth/refresh']);
    });

    it('uses an absolute tokenUrl as-is even when the baseUrl is relative', async () => {
      vi.stubGlobal('location', undefined);
      try {
        const server = tokenServer();
        const t = setup(
          {
            baseUrl: '/',
            securitySchemes: { cc: { type: 'oauth2', tokenUrl: 'https://auth.test/token' } },
            auth: { cc: { clientCredentials: cc } },
            fetch: server.fetch,
          },
          [req_('cc')],
        );
        await t.mw(makeReq(), t.next, t.ctx);
        expect(server.calls.map((c) => c.url)).toEqual(['https://auth.test/token']);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('resolves a relative tokenUrl against a relative baseUrl via globalThis.location', async () => {
      vi.stubGlobal('location', { href: 'https://app.test/page' });
      try {
        const server = tokenServer();
        const t = setup(
          {
            baseUrl: '/api/',
            securitySchemes: { cc: { type: 'oauth2', tokenUrl: 'oauth/token' } },
            auth: { cc: { clientCredentials: cc } },
            fetch: server.fetch,
          },
          [req_('cc')],
        );
        await t.mw(makeReq(), t.next, t.ctx);
        expect(server.calls.map((c) => c.url)).toEqual(['https://app.test/api/oauth/token']);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('maps an unresolvable relative tokenUrl to AuthError', async () => {
      vi.stubGlobal('location', undefined);
      try {
        const server = tokenServer();
        const t = setup(
          {
            baseUrl: '/',
            securitySchemes: { cc: { type: 'oauth2', tokenUrl: '/oauth/token' } },
            auth: { cc: { clientCredentials: cc } },
            fetch: server.fetch,
          },
          [req_('cc')],
        );
        await expect(t.mw(makeReq(), t.next, t.ctx)).rejects.toBeInstanceOf(AuthError);
        expect(server.calls).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('re-resolves the tokenUrl after the baseUrl changes', async () => {
      const server = tokenServer();
      const t = setup(
        {
          baseUrl: 'http://a.test',
          securitySchemes: { cc: { type: 'oauth2', tokenUrl: '/oauth/token' } },
          auth: { cc: { clientCredentials: cc } },
          fetch: server.fetch,
        },
        [req_('cc')],
      );
      await t.mw(makeReq(), t.next, t.ctx);
      t.setConfig({ baseUrl: 'http://b.test' });
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls.map((c) => c.url)).toEqual(['http://a.test/oauth/token', 'http://b.test/oauth/token']);
    });

    it('works for openIdConnect with an explicit tokenUrl', async () => {
      const server = tokenServer();
      const t = setup(
        { auth: { oidc: { clientCredentials: { ...cc, tokenUrl: 'https://idp.test/token' } } }, fetch: server.fetch },
        [req_('oidc')],
      );
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls[0]!.url).toBe('https://idp.test/token');
      expect(t.seen[0]!.headers.get('authorization')).toBe('Bearer tok1');
    });

    it('caches managed tokens across calls and rebuilds managers when auth changes', async () => {
      const server = tokenServer();
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth')]);
      await t.mw(makeReq(), t.next, t.ctx);
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls).toHaveLength(1);
      t.setConfig({ auth: { oauth: { clientCredentials: cc } } });
      await t.mw(makeReq(), t.next, t.ctx);
      expect(server.calls).toHaveLength(2);
    });

    it('retries once on 401 with managed token', async () => {
      const server = tokenServer(['stale', 'fresh']);
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth', ['r'])]);
      const bodies: Response[] = [];
      const next: Next = vi.fn(async (r: ApiRequest) => {
        const auth = r.headers.get('authorization');
        const res = new Response('nope', { status: auth === 'Bearer fresh' ? 200 : 401 });
        bodies.push(res);
        return res;
      });
      const res = await t.mw(makeReq(), next, t.ctx);
      expect(res.status).toBe(200);
      expect(next).toHaveBeenCalledTimes(2);
      expect(server.calls).toHaveLength(2);
      // the first 401 body was cancelled/drained before retrying
      expect(bodies[0]!.bodyUsed).toBe(true);
    });

    it('N parallel 401s with the same stale token trigger exactly one extra token request', async () => {
      const server = tokenServer(['stale', 'fresh']);
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth')]);
      await t.mw(makeReq(), t.next, t.ctx); // primes the cache with 'stale'
      const seenAuth: (string | null)[] = [];
      const next: Next = async (r: ApiRequest) => {
        const auth = r.headers.get('authorization');
        seenAuth.push(auth);
        return new Response('', { status: auth === 'Bearer fresh' ? 200 : 401 });
      };
      const results = await Promise.all([0, 1, 2, 3, 4].map(() => t.mw(makeReq(), next, t.ctx)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(server.calls).toHaveLength(2);
      expect(seenAuth.filter((a) => a === 'Bearer fresh')).toHaveLength(5);
    });

    it('retries at most once', async () => {
      const server = tokenServer();
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth')]);
      const next: Next = vi.fn(async () => new Response('', { status: 401 }));
      const res = await t.mw(makeReq(), next, t.ctx);
      expect(res.status).toBe(401);
      expect(next).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the request is not replayable', async () => {
      const server = tokenServer();
      const t = setup({ auth: { oauth: { clientCredentials: cc } }, fetch: server.fetch }, [req_('oauth')]);
      const next: Next = vi.fn(async () => new Response('', { status: 401 }));
      const res = await t.mw(makeReq({ replayable: false }), next, t.ctx);
      expect(res.status).toBe(401);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('does not retry 401 for non-managed tokens', async () => {
      const t = setup({ auth: { oauth: { accessToken: 'x' }, bearer: 'y' } }, [req_('oauth')]);
      const next: Next = vi.fn(async () => new Response('', { status: 401 }));
      expect((await t.mw(makeReq(), next, t.ctx)).status).toBe(401);
      expect(next).toHaveBeenCalledTimes(1);

      const t2 = setup({ auth: { bearer: 'y' } }, [req_('bearer')]);
      const next2: Next = vi.fn(async () => new Response('', { status: 401 }));
      expect((await t2.mw(makeReq(), next2, t2.ctx)).status).toBe(401);
      expect(next2).toHaveBeenCalledTimes(1);
    });
  });
});
