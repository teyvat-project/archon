import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/errors.js';
import { OAuth2TokenManager } from '../src/oauth2.js';
import type { FetchLike } from '../src/transport.js';
import type { TokenSet } from '../src/types.js';

type Call = { url: string; init: RequestInit; headers: Headers; form: URLSearchParams };

function tokenFetch(
  respond: (call: Call, n: number) => Response | Promise<Response>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const call: Call = {
      url: String(input),
      init,
      headers: new Headers(init.headers),
      form: new URLSearchParams(String(init.body ?? '')),
    };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const cc = { clientId: 'id', clientSecret: 'secret' };

describe('OAuth2TokenManager', () => {
  it('fetches client credentials token with basic client auth', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    expect(m.managed).toBe(true);
    await expect(m.getToken(['read', 'write'])).resolves.toBe('tok');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://auth.test/token');
    expect(call.init.method).toBe('POST');
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.headers.get('authorization')).toBe(`Basic ${btoa('id:secret')}`);
    expect(call.form.get('grant_type')).toBe('client_credentials');
    expect(call.form.get('scope')).toBe('read write');
    expect(call.form.has('client_id')).toBe(false);
    expect(call.form.has('client_secret')).toBe(false);
  });

  it('sends client credentials in the body for clientAuth post', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: { ...cc, clientAuth: 'post' } },
      tokenUrl: 'https://auth.test/token',
    });
    await m.getToken([]);
    const call = calls[0]!;
    expect(call.headers.has('authorization')).toBe(false);
    expect(call.form.get('client_id')).toBe('id');
    expect(call.form.get('client_secret')).toBe('secret');
    expect(call.form.has('scope')).toBe(false);
  });

  it('prefers the configured tokenUrl over the spec tokenUrl', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: { ...cc, tokenUrl: 'https://cfg.test/token' } },
      tokenUrl: 'https://spec.test/token',
    });
    await m.getToken([]);
    expect(calls[0]!.url).toBe('https://cfg.test/token');
  });

  describe('relative token URLs (resolved against baseUrl)', () => {
    const resolveCase = async (tokenUrl: string, baseUrl: string | undefined, configured?: string) => {
      const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
      const m = new OAuth2TokenManager({
        fetch,
        config: { clientCredentials: configured === undefined ? cc : { ...cc, tokenUrl: configured } },
        tokenUrl,
        ...(baseUrl !== undefined && { baseUrl }),
      });
      await m.getToken([]);
      return calls[0]!.url;
    };

    it('resolves an absolute-path tokenUrl against the origin of a baseUrl with a path prefix', async () => {
      await expect(resolveCase('/oauth/token', 'http://h/api/')).resolves.toBe('http://h/oauth/token');
    });

    it('resolves a path-relative tokenUrl against the baseUrl path', async () => {
      await expect(resolveCase('oauth/token', 'http://h/api/')).resolves.toBe('http://h/api/oauth/token');
    });

    it('leaves an absolute tokenUrl unchanged', async () => {
      await expect(resolveCase('https://auth.test/token', 'http://h/api/')).resolves.toBe('https://auth.test/token');
    });

    it('resolves a relative tokenUrl from the config as well', async () => {
      await expect(resolveCase('https://spec.test/token', 'http://h:8080/api', '/cfg/token')).resolves.toBe(
        'http://h:8080/cfg/token',
      );
    });

    it('passes a relative tokenUrl through unchanged without a baseUrl', async () => {
      await expect(resolveCase('/oauth/token', undefined)).resolves.toBe('/oauth/token');
    });

    describe('with a relative baseUrl', () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('uses an absolute tokenUrl as-is', async () => {
        vi.stubGlobal('location', undefined);
        await expect(resolveCase('https://auth.test/token', '/')).resolves.toBe('https://auth.test/token');
      });

      it('resolves against globalThis.location when available', async () => {
        vi.stubGlobal('location', { href: 'https://app.test/x/y' });
        await expect(resolveCase('oauth/token', '/api/')).resolves.toBe('https://app.test/api/oauth/token');
      });

      it('throws AuthError when the token URL cannot be resolved', async () => {
        vi.stubGlobal('location', undefined);
        await expect(resolveCase('/oauth/token', '/api')).rejects.toBeInstanceOf(AuthError);
        await expect(resolveCase('/oauth/token', '/api')).rejects.toThrow(/tokenUrl/);
      });
    });
  });

  it('throws AuthError when no tokenUrl is available', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc } });
    await expect(m.getToken([])).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(0);
  });

  it('is not managed with only an accessToken', () => {
    const { fetch } = tokenFetch(() => json({}));
    expect(new OAuth2TokenManager({ fetch, config: { accessToken: 'x' } }).managed).toBe(false);
  });

  it('caches until 30s before expiry then refreshes', async () => {
    let now = 1_000_000;
    const { fetch, calls } = tokenFetch((_c, n) => json({ access_token: `tok${n}`, expires_in: 100 }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
      now: () => now,
    });
    await expect(m.getToken(['a'])).resolves.toBe('tok1');
    now += 69_999; // 100s - 30s leeway = 70s of validity
    await expect(m.getToken(['a'])).resolves.toBe('tok1');
    expect(calls).toHaveLength(1);
    now += 1;
    await expect(m.getToken(['a'])).resolves.toBe('tok2');
    expect(calls).toHaveLength(2);
  });

  it('honors a custom leewayMs', async () => {
    let now = 0;
    const { fetch, calls } = tokenFetch((_c, n) => json({ access_token: `tok${n}`, expires_in: 10 }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
      leewayMs: 0,
      now: () => now,
    });
    await m.getToken([]);
    now = 9_999;
    await m.getToken([]);
    expect(calls).toHaveLength(1);
    now = 10_000;
    await m.getToken([]);
    expect(calls).toHaveLength(2);
  });

  it('never expires a token without expires_in', async () => {
    let now = 0;
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
      now: () => now,
    });
    await m.getToken([]);
    now = 10 ** 12;
    await m.getToken([]);
    expect(calls).toHaveLength(1);
  });

  it('keys the cache by sorted scopes', async () => {
    const { fetch, calls } = tokenFetch((_c, n) => json({ access_token: `tok${n}` }));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    await expect(m.getToken(['b', 'a'])).resolves.toBe('tok1');
    await expect(m.getToken(['a', 'b'])).resolves.toBe('tok1');
    await expect(m.getToken(['a'])).resolves.toBe('tok2');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.form.get('scope')).toBe('a b');
  });

  it('merges configured default scopes with the requested scopes', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: { ...cc, scopes: ['base', 'read'] } },
      tokenUrl: 'https://auth.test/token',
    });
    await m.getToken(['write', 'read']);
    expect(calls[0]!.form.get('scope')).toBe('base read write');
  });

  it('single-flight concurrent getToken', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = tokenFetch(async () => {
      await gate;
      return json({ access_token: 'tok' });
    });
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    const all = Promise.all([m.getToken(['a']), m.getToken(['a']), m.getToken(['a'])]);
    release();
    await expect(all).resolves.toEqual(['tok', 'tok', 'tok']);
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failed fetch and lets the next call retry', async () => {
    const { fetch, calls } = tokenFetch((_c, n) => (n === 1 ? json({ error: 'x' }, 500) : json({ access_token: 'ok' })));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    await expect(m.getToken([])).rejects.toBeInstanceOf(AuthError);
    await expect(m.getToken([])).resolves.toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('invalidate() forces a new fetch', async () => {
    const { fetch, calls } = tokenFetch((_c, n) => json({ access_token: `tok${n}` }));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    await expect(m.getToken([])).resolves.toBe('tok1');
    m.invalidate();
    await expect(m.getToken([])).resolves.toBe('tok2');
    expect(calls).toHaveLength(2);
  });

  it('invalidate(rejectedToken) only drops a cache entry holding that token', async () => {
    const { fetch, calls } = tokenFetch((_c, n) => json({ access_token: `tok${n}` }));
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    await expect(m.getToken([])).resolves.toBe('tok1');
    m.invalidate('some-other-token');
    await expect(m.getToken([])).resolves.toBe('tok1');
    expect(calls).toHaveLength(1);
    m.invalidate('tok1');
    await expect(m.getToken([])).resolves.toBe('tok2');
    expect(calls).toHaveLength(2);
  });

  it('invalidate() does not detach an in-flight fetch; later callers join it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = tokenFetch(async (_c, n) => {
      await gate;
      return json({ access_token: `tok${n}` });
    });
    const m = new OAuth2TokenManager({ fetch, config: { clientCredentials: cc }, tokenUrl: 'https://auth.test/token' });
    const first = m.getToken([]);
    m.invalidate('stale');
    m.invalidate();
    const second = m.getToken([]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['tok1', 'tok1']);
    expect(calls).toHaveLength(1);
  });

  it('refresh flow: concurrent invalidate + getToken yields one grant and keeps the latest refresh token', async () => {
    const onRefreshed = vi.fn<(t: TokenSet) => void>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = tokenFetch(async (_c, n) => {
      if (n > 1) await gate;
      return json({ access_token: `at${n}`, refresh_token: `rt${n}` });
    });
    const m = new OAuth2TokenManager({
      fetch,
      config: { refreshToken: { refreshToken: 'rt0', clientId: 'id', onRefreshed } },
      tokenUrl: 'https://auth.test/refresh',
    });
    await expect(m.getToken([])).resolves.toBe('at1');
    const retries = [0, 1, 2, 3, 4].map(() => {
      m.invalidate('at1');
      return m.getToken([]);
    });
    release();
    await expect(Promise.all(retries)).resolves.toEqual(Array(5).fill('at2'));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.form.get('refresh_token')).toBe('rt1');
    expect(onRefreshed).toHaveBeenCalledTimes(2);
    m.invalidate('at2');
    await m.getToken([]);
    expect(calls[2]!.form.get('refresh_token')).toBe('rt2');
  });

  it('refresh grant rotates refresh token and calls onRefreshed', async () => {
    let now = 5_000;
    const onRefreshed = vi.fn<(t: TokenSet) => void>();
    const { fetch, calls } = tokenFetch((_c, n) =>
      json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 60, scope: 'read' }),
    );
    const m = new OAuth2TokenManager({
      fetch,
      config: { refreshToken: { refreshToken: 'rt0', clientId: 'id', clientSecret: 'secret', onRefreshed } },
      tokenUrl: 'https://auth.test/refresh',
      now: () => now,
    });
    expect(m.managed).toBe(true);
    await expect(m.getToken(['read'])).resolves.toBe('at1');
    expect(calls[0]!.form.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.form.get('refresh_token')).toBe('rt0');
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${btoa('id:secret')}`);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenCalledWith({
      accessToken: 'at1',
      refreshToken: 'rt1',
      expiresAt: 5_000 + 60_000,
      scope: 'read',
    });

    now += 60_000;
    await expect(m.getToken(['read'])).resolves.toBe('at2');
    expect(calls[1]!.form.get('refresh_token')).toBe('rt1');
  });

  it('keeps the old refresh token and skips onRefreshed when the response has none', async () => {
    const onRefreshed = vi.fn();
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'at' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { refreshToken: { refreshToken: 'rt0', clientId: 'id', onRefreshed } },
      tokenUrl: 'https://auth.test/refresh',
    });
    await m.getToken([]);
    m.invalidate();
    await m.getToken([]);
    expect(onRefreshed).not.toHaveBeenCalled();
    expect(calls[1]!.form.get('refresh_token')).toBe('rt0');
    // public client: no secret, so client_id goes in the body and no Authorization header is sent
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(calls[0]!.form.get('client_id')).toBe('id');
  });

  it('AuthError on token endpoint failure', async () => {
    const { fetch } = tokenFetch(() => json({ error: 'invalid_client' }, 401));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
      scheme: 'oauth2',
    });
    const err = await m.getToken([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).schemes).toEqual(['oauth2']);
    expect((err as AuthError).message).toContain('401');
  });

  it('AuthError when the response lacks access_token or is not JSON', async () => {
    const missing = tokenFetch(() => json({ token_type: 'Bearer' }));
    const m1 = new OAuth2TokenManager({
      fetch: missing.fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
    });
    await expect(m1.getToken([])).rejects.toBeInstanceOf(AuthError);

    const html = tokenFetch(() => new Response('<html>', { status: 200 }));
    const m2 = new OAuth2TokenManager({
      fetch: html.fetch,
      config: { clientCredentials: cc },
      tokenUrl: 'https://auth.test/token',
    });
    await expect(m2.getToken([])).rejects.toBeInstanceOf(AuthError);
  });

  it('AuthError when neither flow is configured', async () => {
    const { fetch } = tokenFetch(() => json({}));
    const m = new OAuth2TokenManager({ fetch, config: { accessToken: 'x' }, tokenUrl: 'https://auth.test/token' });
    await expect(m.getToken([])).rejects.toBeInstanceOf(AuthError);
  });
});

describe('OAuth2TokenManager form encoding', () => {
  it('percent-encodes reserved characters in the body', async () => {
    const { fetch, calls } = tokenFetch(() => json({ access_token: 'tok' }));
    const m = new OAuth2TokenManager({
      fetch,
      config: { clientCredentials: { clientId: 'a&b', clientSecret: 's=1+2 (x)', clientAuth: 'post' } },
      tokenUrl: 'https://auth.test/token',
    });
    await m.getToken(['x y']);
    const raw = String(calls[0]!.init.body);
    expect(raw).toContain('client_secret=s%3D1%2B2+%28x%29');
    expect(calls[0]!.form.get('client_id')).toBe('a&b');
    expect(calls[0]!.form.get('client_secret')).toBe('s=1+2 (x)');
    expect(calls[0]!.form.get('scope')).toBe('x y');
  });
});
