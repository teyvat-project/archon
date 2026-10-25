import { errorReply, type Route } from '../http.js';
import { hasApiKeyHeader } from './auth.js';

export const redirectRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/redirect\/cross-origin$/,
    handle: (req, _match, state) =>
      hasApiKeyHeader(req)
        ? { status: 302, headers: { Location: `${state.secondaryUrl}/echo/headers` } }
        : errorReply(401, 'Missing or invalid credentials'),
  },
];
