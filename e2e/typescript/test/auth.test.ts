import { describe, expect, it } from 'vitest';
import {
  AuthError,
  authAnd,
  authApiKeyCookie,
  authApiKeyHeader,
  authApiKeyQuery,
  authBasic,
  authBearer,
  authOAuth2,
  authOptional,
  createApiClient,
} from '../generated/default/index.js';
import { baseUrl, requestCount, stats } from './support.js';

const clientCredentials = { clientId: 'client-id', clientSecret: 'client-secret' };

describe('authentication', () => {
  it('bearer', async () => {
    const client = createApiClient({ baseUrl, auth: { bearerAuth: 'test-token' } });
    const { data, response } = await authBearer({ client });
    expect(response.status).toBe(200);
    expect(data!.headers['authorization']).toBe('Bearer test-token');
  });

  it('basic', async () => {
    const client = createApiClient({ baseUrl, auth: { basicAuth: { username: 'user', password: 'pass' } } });
    const { response } = await authBasic({ client });
    expect(response.status).toBe(200);
  });

  it('apiKey in a header', async () => {
    const client = createApiClient({ baseUrl, auth: { apiKeyHeader: 'test-key' } });
    const { data, response } = await authApiKeyHeader({ client });
    expect(response.status).toBe(200);
    expect(data!.headers['x-api-key']).toBe('test-key');
  });

  it('apiKey in the query', async () => {
    const client = createApiClient({ baseUrl, auth: { apiKeyQuery: async () => 'test-key' } });
    const { data, response } = await authApiKeyQuery({ client });
    expect(response.status).toBe(200);
    expect(data!.query).toBe('api_key=test-key');
  });

  it('apiKey in a cookie', async () => {
    const client = createApiClient({ baseUrl, auth: { apiKeyCookie: 'test-key' } });
    const { data, response } = await authApiKeyCookie({ client });
    expect(response.status).toBe(200);
    expect(data!.cookies).toEqual({ session: 'test-key' });
  });

  it('rejects a wrong credential with a typed 401', async () => {
    const client = createApiClient({ baseUrl, auth: { bearerAuth: 'wrong' } });
    const { error, response } = await authBearer({ client });
    expect(response.status).toBe(401);
    expect(error!.body).toEqual({ code: 401, message: expect.any(String) });
  });

  it('throws AuthError without sending when required auth is missing', async () => {
    const before = await requestCount('/auth/bearer');
    const client = createApiClient({ baseUrl });
    const call = authBearer({ client });
    await expect(call).rejects.toBeInstanceOf(AuthError);
    await expect(call).rejects.toMatchObject({ schemes: ['bearerAuth'] });
    expect(await requestCount('/auth/bearer')).toBe(before);
  });

  it('sends anonymously when auth is optional and not configured', async () => {
    const client = createApiClient({ baseUrl });
    const { data, response } = await authOptional({ client });
    expect(response.status).toBe(200);
    expect(data!.headers['authorization']).toBeUndefined();
  });

  it('uses the credential for optional auth when it is configured', async () => {
    const client = createApiClient({ baseUrl, auth: { bearerAuth: 'test-token' } });
    const { data } = await authOptional({ client, throwOnError: true });
    expect(data.headers['authorization']).toBe('Bearer test-token');
  });

  it('requires every scheme of an AND requirement', async () => {
    const before = await requestCount('/auth/and');
    const partial = createApiClient({ baseUrl, auth: { bearerAuth: 'test-token' } });
    await expect(authAnd({ client: partial })).rejects.toBeInstanceOf(AuthError);
    expect(await requestCount('/auth/and')).toBe(before);

    const both = createApiClient({ baseUrl, auth: { bearerAuth: 'test-token', apiKeyHeader: 'test-key' } });
    const { response } = await authAnd({ client: both });
    expect(response.status).toBe(200);
  });

  describe('oauth2', () => {
    it('obtains a token with client credentials from the relative tokenUrl', async () => {
      const before = await stats();
      const client = createApiClient({ baseUrl, auth: { oauth2: { clientCredentials } } });
      const { data, response } = await authOAuth2({ client });
      expect(response.status).toBe(200);
      expect(data!.headers['authorization']).toMatch(/^Bearer /);
      expect((await stats()).tokensIssued).toBe(before.tokensIssued + 1);
    });

    it('obtains a token with the refresh-token grant', async () => {
      const refreshed: string[] = [];
      const client = createApiClient({
        baseUrl,
        auth: {
          oauth2: {
            refreshToken: {
              refreshToken: 'test-refresh-token',
              ...clientCredentials,
              onRefreshed: (tokens) => void refreshed.push(tokens.refreshToken!),
            },
          },
        },
      });
      const { response } = await authOAuth2({ client });
      expect(response.status).toBe(200);
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]).not.toBe('test-refresh-token');
    });

    it('renews the token before it expires instead of waiting for a 401', async () => {
      const client = createApiClient({ baseUrl, auth: { oauth2: { clientCredentials } } });
      const before = await stats();

      const first = await authOAuth2({ client });
      expect(first.response.status).toBe(200);
      // The token lives 2 s, well inside the 30 s renewal leeway, so it is never reused and the server
      // never sees an expired token: each call renews it up front.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const second = await authOAuth2({ client });
      expect(second.response.status).toBe(200);
      expect(second.data!.headers['authorization']).not.toBe(first.data!.headers['authorization']);

      const after = await stats();
      expect(after.tokensIssued - before.tokensIssued).toBe(2);
      // No 401 round trip: exactly one request per call.
      expect((after.requests['/auth/oauth2'] ?? 0) - (before.requests['/auth/oauth2'] ?? 0)).toBe(2);
    });

    it('issues a single token for concurrent requests on a cold client', async () => {
      const client = createApiClient({ baseUrl, auth: { oauth2: { clientCredentials } } });
      const before = await stats();
      const results = await Promise.all(Array.from({ length: 5 }, () => authOAuth2({ client })));
      expect(results.map((r) => r.response.status)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.data!.headers['authorization'])).size).toBe(1);
      expect((await stats()).tokensIssued - before.tokensIssued).toBe(1);
    });
  });
});
