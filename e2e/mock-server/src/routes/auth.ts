import { CREDENTIALS, errorReply, header, json, parseCookies, type Received, type Route, type ServerState } from '../http.js';
import { echo } from './echo.js';

const basicCredentials = `Basic ${Buffer.from(`${CREDENTIALS.basic.username}:${CREDENTIALS.basic.password}`).toString('base64')}`;

export const hasBearer = (req: Received) => header(req, 'authorization') === `Bearer ${CREDENTIALS.bearer}`;
export const hasApiKeyHeader = (req: Received) => header(req, 'x-api-key') === CREDENTIALS.apiKey;

/** True when the request carries an issued, unexpired access token granted `scope`. */
function hasAccessToken(req: Received, state: ServerState, scope: string): boolean {
  const token = /^Bearer (.+)$/.exec(header(req, 'authorization') ?? '')?.[1];
  const grant = token === undefined ? undefined : state.accessTokens.get(token);
  return grant !== undefined && grant.expiresAt > Date.now() && grant.scopes.includes(scope);
}

const unauthorized = () => errorReply(401, 'Missing or invalid credentials');

function guarded(path: RegExp, check: (req: Received, state: ServerState) => boolean): Route {
  return {
    method: 'GET',
    path,
    handle: (req, _match, state) => (check(req, state) ? json(200, echo(req)) : unauthorized()),
  };
}

export const authRoutes: Route[] = [
  guarded(/^\/auth\/bearer$/, hasBearer),
  guarded(/^\/auth\/basic$/, (req) => header(req, 'authorization') === basicCredentials),
  guarded(/^\/auth\/api-key-header$/, hasApiKeyHeader),
  guarded(/^\/auth\/api-key-query$/, (req) => new URLSearchParams(req.query).get('api_key') === CREDENTIALS.apiKey),
  guarded(/^\/auth\/api-key-cookie$/, (req) => parseCookies(req)['session'] === CREDENTIALS.apiKey),
  guarded(/^\/auth\/oauth2$/, (req, state) => hasAccessToken(req, state, 'read')),
  // Anonymous is fine, but credentials that are sent must be valid.
  guarded(/^\/auth\/optional$/, (req) => header(req, 'authorization') === undefined || hasBearer(req)),
  guarded(/^\/auth\/and$/, (req) => hasBearer(req) && hasApiKeyHeader(req)),
];
