import type { CallContext, Middleware, Next } from './types.js';

/** Builds an onion chain: `middleware[0]` is outermost, `terminal` runs last. */
export function compose(middleware: Middleware[], terminal: Next, ctx: CallContext): Next {
  return middleware.reduceRight<Next>((next, mw) => (req) => mw(req, next, ctx), terminal);
}
