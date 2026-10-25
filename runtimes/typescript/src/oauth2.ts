import { base64Encode } from './base64.js';
import type { OAuth2Value } from './client.js';
import { AuthError } from './errors.js';
import type { FetchLike } from './transport.js';
import type { TokenSet } from './types.js';

export interface OAuth2TokenManagerOptions {
  fetch: FetchLike;
  config: OAuth2Value;
  /** Default token endpoint (from the spec); a `tokenUrl` inside `config` takes precedence. */
  tokenUrl?: string;
  /** Tokens are renewed this many milliseconds before they expire. Default 30_000. */
  leewayMs?: number;
  now?: () => number;
  /** Scheme name, reported in `AuthError.schemes`. */
  scheme?: string;
}

const DEFAULT_LEEWAY_MS = 30_000;

/** application/x-www-form-urlencoded component encoding (space as `+`). */
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * Obtains and caches OAuth2 access tokens through the client-credentials or refresh-token grant.
 * Concurrent requests for the same scopes share a single token request.
 */
export class OAuth2TokenManager {
  readonly managed: boolean;

  private readonly fetchImpl: FetchLike;
  private readonly config: OAuth2Value;
  private readonly specTokenUrl: string | undefined;
  private readonly leewayMs: number;
  private readonly now: () => number;
  private readonly schemes: string[];
  private readonly cache = new Map<string, TokenSet>();
  private readonly inflight = new Map<string, Promise<TokenSet>>();
  private refreshToken: string | undefined;
  private generation = 0;

  constructor(opts: OAuth2TokenManagerOptions) {
    this.fetchImpl = opts.fetch;
    this.config = opts.config;
    this.specTokenUrl = opts.tokenUrl;
    this.leewayMs = opts.leewayMs ?? DEFAULT_LEEWAY_MS;
    this.now = opts.now ?? (() => Date.now());
    this.schemes = opts.scheme === undefined ? [] : [opts.scheme];
    this.refreshToken = opts.config.refreshToken?.refreshToken;
    this.managed = opts.config.clientCredentials !== undefined || opts.config.refreshToken !== undefined;
  }

  async getToken(scopes: string[]): Promise<string> {
    const requested = this.requestedScopes(scopes);
    const key = this.config.refreshToken ? '' : requested.join(' ');

    const cached = this.cache.get(key);
    if (cached && this.isFresh(cached)) return cached.accessToken;

    let pending = this.inflight.get(key);
    if (!pending) {
      const generation = this.generation;
      pending = this.fetchToken(requested).then(
        (tokens) => {
          if (generation === this.generation) {
            this.cache.set(key, tokens);
            this.inflight.delete(key);
          }
          return tokens;
        },
        (error: unknown) => {
          if (generation === this.generation) this.inflight.delete(key);
          throw error;
        },
      );
      this.inflight.set(key, pending);
    }
    return (await pending).accessToken;
  }

  /** Drops every cached token and detaches in-flight requests so the next `getToken` fetches anew. */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
  }

  private isFresh(tokens: TokenSet): boolean {
    return tokens.expiresAt === undefined || tokens.expiresAt - this.leewayMs > this.now();
  }

  /** Union of the requested and the configured default scopes, deduplicated and sorted. */
  private requestedScopes(scopes: string[]): string[] {
    const configured = this.config.clientCredentials?.scopes ?? [];
    return [...new Set([...scopes, ...configured])].sort();
  }

  private async fetchToken(scopes: string[]): Promise<TokenSet> {
    const refresh = this.config.refreshToken;
    const flow = refresh ?? this.config.clientCredentials;
    if (!flow) throw new AuthError('OAuth2 scheme has neither clientCredentials nor refreshToken configured', this.schemes);
    const tokenUrl = flow.tokenUrl ?? this.specTokenUrl;
    if (!tokenUrl) throw new AuthError('No tokenUrl configured for the OAuth2 token request', this.schemes);

    const form: [string, string][] = [];
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    if (refresh) {
      form.push(['grant_type', 'refresh_token'], ['refresh_token', this.refreshToken ?? refresh.refreshToken]);
    } else {
      form.push(['grant_type', 'client_credentials']);
      if (scopes.length > 0) form.push(['scope', scopes.join(' ')]);
    }

    const clientId = (refresh ?? this.config.clientCredentials!).clientId;
    const clientSecret = refresh ? refresh.clientSecret : this.config.clientCredentials!.clientSecret;
    if (clientSecret !== undefined && (flow.clientAuth ?? 'basic') === 'basic') {
      headers.set('Authorization', `Basic ${base64Encode(`${clientId}:${clientSecret}`)}`);
    } else {
      form.push(['client_id', clientId]);
      if (clientSecret !== undefined) form.push(['client_secret', clientSecret]);
    }

    const body = form.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join('&');
    const response = await this.fetchImpl(tokenUrl, { method: 'POST', headers, body });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AuthError(`Token endpoint responded with HTTP ${response.status}`, this.schemes);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AuthError('Token endpoint returned a response that is not valid JSON', this.schemes);
    }
    const data = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (typeof data['access_token'] !== 'string' || data['access_token'] === '') {
      throw new AuthError('Token endpoint response has no access_token', this.schemes);
    }

    const tokens: TokenSet = { accessToken: data['access_token'] };
    const expiresIn = Number(data['expires_in']);
    if (data['expires_in'] !== undefined && data['expires_in'] !== null && Number.isFinite(expiresIn)) {
      tokens.expiresAt = this.now() + expiresIn * 1000;
    }
    if (typeof data['scope'] === 'string') tokens.scope = data['scope'];
    if (typeof data['refresh_token'] === 'string' && data['refresh_token'] !== '') {
      tokens.refreshToken = data['refresh_token'];
      if (refresh) {
        this.refreshToken = tokens.refreshToken;
        await refresh.onRefreshed?.({ ...tokens });
      }
    }
    return tokens;
  }
}
