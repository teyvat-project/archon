import { errorReply, json, type Route } from '../http.js';

export const flakyRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/flaky\/([^/]+)$/,
    handle: (req, match, state) => {
      const key = decodeURIComponent(match[1]!);
      const fail = Number(new URLSearchParams(req.query).get('fail') ?? '0');
      const attempts = (state.flakyAttempts.get(key) ?? 0) + 1;
      state.flakyAttempts.set(key, attempts);
      if (attempts <= fail) {
        const reply = errorReply(503, 'Temporarily unavailable');
        return { ...reply, headers: { ...reply.headers, 'Retry-After': '0' } };
      }
      return json(200, { key, attempts });
    },
  },
];
