import { randomUUID } from 'node:crypto';
import { CREDENTIALS, header, json, TOKEN_LIFETIME_S, type Received, type Route, type ServerState } from '../http.js';

const SUPPORTED_SCOPES = ['read', 'write'];

const oauthError = (status: number, error: string) => json(status, { error });

/** Client authentication through HTTP Basic (`client_secret_basic`) or the form (`client_secret_post`). */
function authenticatesClient(req: Received, form: URLSearchParams): boolean {
  const basic = /^Basic (.+)$/.exec(header(req, 'authorization') ?? '')?.[1];
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  if (basic !== undefined) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    id = decodeURIComponent(decoded.slice(0, colon));
    secret = decodeURIComponent(decoded.slice(colon + 1));
  }
  return id === CREDENTIALS.oauth2.clientId && secret === CREDENTIALS.oauth2.clientSecret;
}

function issue(state: ServerState, scopes: string[], withRefreshToken: boolean) {
  const accessToken = `at-${randomUUID()}`;
  state.accessTokens.set(accessToken, { expiresAt: Date.now() + TOKEN_LIFETIME_S * 1000, scopes });
  state.stats.tokensIssued++;
  const body: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_LIFETIME_S,
    scope: scopes.join(' '),
  };
  if (withRefreshToken) {
    const refreshToken = `rt-${randomUUID()}`;
    state.refreshTokens.add(refreshToken);
    body['refresh_token'] = refreshToken;
  }
  return json(200, body, { 'Cache-Control': 'no-store' });
}

export const oauthRoutes: Route[] = [
  {
    method: 'POST',
    path: /^\/oauth\/token$/,
    handle: (req, _match, state) => {
      if (!(header(req, 'content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
        return oauthError(400, 'invalid_request');
      }
      const form = new URLSearchParams(req.body.toString('utf8'));
      if (!authenticatesClient(req, form)) return oauthError(401, 'invalid_client');

      switch (form.get('grant_type')) {
        case 'client_credentials': {
          const scopes = (form.get('scope') ?? '').split(' ').filter((s) => s !== '');
          if (scopes.some((s) => !SUPPORTED_SCOPES.includes(s))) return oauthError(400, 'invalid_scope');
          return issue(state, scopes, false);
        }
        case 'refresh_token': {
          const refreshToken = form.get('refresh_token');
          if (refreshToken === null || !state.refreshTokens.has(refreshToken)) return oauthError(400, 'invalid_grant');
          return issue(state, SUPPORTED_SCOPES, true);
        }
        default:
          return oauthError(400, 'unsupported_grant_type');
      }
    },
  },
];
