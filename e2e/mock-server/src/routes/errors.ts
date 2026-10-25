import { errorReply, json, type Route } from '../http.js';

const validationError = () =>
  json(400, { message: 'Validation failed', fields: [{ name: 'status', reason: 'invalid' }] });

export const errorRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/errors\/([^/]+)$/,
    handle: (_req, match) => {
      const raw = match[1]!;
      const status = /^\d{3}$/.test(raw) ? Number(raw) : NaN;
      if (status === 200) return json(200, { ok: true });
      if (status === 404) return json(404, { message: 'Not found', resource: `errors/${raw}` });
      // 400, and anything that cannot be answered with an error body.
      if (status === 400 || !(status >= 401 && status <= 599)) return validationError();
      return errorReply(status, `HTTP ${status}`);
    },
  },
];
