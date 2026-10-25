import type { IncomingHttpHeaders } from 'node:http';

/** A request as received, before any decoding. */
export interface Received {
  method: string;
  /** Raw request path (percent-encoding preserved), without the query string. */
  path: string;
  /** Raw query string without the leading `?` (`''` when absent). */
  query: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** Fixed credentials the server accepts. */
export const CREDENTIALS = {
  bearer: 'test-token',
  basic: { username: 'user', password: 'pass' },
  apiKey: 'test-key',
  oauth2: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'test-refresh-token' },
} as const;

/** Lifetime of issued OAuth2 access tokens, in seconds. */
export const TOKEN_LIFETIME_S = 2;

export interface ServerState {
  /** Origin of the echo-only secondary server (for cross-origin redirects). */
  secondaryUrl: string;
  stats: { tokensIssued: number; requests: Record<string, number> };
  accessTokens: Map<string, { expiresAt: number; scopes: string[] }>;
  refreshTokens: Set<string>;
  /** Attempts seen so far per `/flaky/{key}`. */
  flakyAttempts: Map<string, number>;
}

export interface Route {
  method: string;
  /** Matched against the raw path. */
  path: RegExp;
  handle(req: Received, match: RegExpExecArray, state: ServerState): Reply | Promise<Reply>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export function errorReply(status: number, message: string): Reply {
  return json(status, { code: status, message });
}

/** Header value as one string (repeated headers joined like Node does for most names). */
export function header(req: Received, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Cookie pairs with their raw (still encoded) values. */
export function parseCookies(req: Received): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of (header(req, 'cookie') ?? '').split(';')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) cookies[trimmed] = '';
    else cookies[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return cookies;
}
