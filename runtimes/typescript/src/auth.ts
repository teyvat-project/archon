import type { ClientConfig } from './client.js';
import type { Middleware } from './types.js';

/** Placeholder until auth application is implemented: passes requests through unchanged. */
export function createAuthMiddleware(_getConfig: () => ClientConfig<any>): Middleware {
  return (req, next) => next(req);
}
