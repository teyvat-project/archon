import { isReadableStream } from './body.js';
import { TransportError } from './errors.js';
import type { ApiRequest, HttpMethod, RequestBody } from './types.js';

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface SendOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  /** Header names (any case) that carry credentials and must not cross origins. */
  credentialHeaders: string[];
  /** Query parameter names that carry credentials and must not cross origins. */
  credentialQuery: string[];
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

interface Hop {
  method: HttpMethod;
  url: URL;
  headers: Headers;
  body: RequestBody | null;
}

function carriesCredentials(req: ApiRequest, opts: SendOptions): boolean {
  if (req.headers.has('cookie')) return true;
  if (opts.credentialHeaders.some((name) => req.headers.has(name))) return true;
  return opts.credentialQuery.some((name) => req.url.searchParams.has(name));
}

/** Links the caller's signal and the timeout into one signal (no `AbortSignal.any` / `AbortSignal.timeout`). */
function linkSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  const state = { timedOut: false };
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          state.timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  return { signal: controller.signal, state, clear: () => clearTimeout(timer) };
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect body is never read.
  }
}

/** Follows redirects by hand so credentials are dropped when the origin changes (spec §8.5). */
async function followManually(
  req: ApiRequest,
  call: (hop: Hop, redirect: RequestRedirect) => Promise<Response>,
  opts: SendOptions,
): Promise<Response> {
  const hop: Hop = { method: req.method, url: new URL(req.url), headers: new Headers(req.headers), body: req.body };
  for (let redirects = 0; ; redirects++) {
    const response = await call(hop, 'manual');
    // Browsers hide manual redirects; nothing more can be done there.
    if (response.type === 'opaqueredirect') return response;
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;

    const keepsBody = response.status === 307 || response.status === 308;
    if (keepsBody && !req.replayable) return response;
    if (redirects >= MAX_REDIRECTS) {
      await discard(response);
      throw new TransportError(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }
    await discard(response);

    const next = new URL(location, hop.url);
    if (next.origin !== hop.url.origin) {
      for (const name of [...opts.credentialHeaders, 'authorization', 'cookie']) hop.headers.delete(name);
      for (const name of opts.credentialQuery) next.searchParams.delete(name);
    }
    if (response.status === 303 ? hop.method !== 'HEAD' : !keepsBody && hop.method === 'POST') {
      hop.method = 'GET';
      hop.body = null;
      for (const name of BODY_HEADERS) hop.headers.delete(name);
    }
    hop.url = next;
  }
}

export async function send(req: ApiRequest, opts: SendOptions): Promise<Response> {
  const linked = linkSignals(req.signal, opts.timeoutMs);
  const call = (hop: Hop, redirect: RequestRedirect) => {
    const init = {
      method: hop.method,
      headers: hop.headers,
      body: hop.body,
      redirect,
      signal: linked.signal,
      // Required by Node's fetch for stream bodies.
      ...(isReadableStream(hop.body) ? { duplex: 'half' } : {}),
    };
    return opts.fetch(hop.url.toString(), init as RequestInit);
  };

  try {
    if (typeof document === 'undefined' && carriesCredentials(req, opts)) {
      return await followManually(req, call, opts);
    }
    return await call({ method: req.method, url: req.url, headers: req.headers, body: req.body }, 'follow');
  } catch (cause) {
    if (cause instanceof TransportError) throw cause;
    if (linked.state.timedOut) {
      throw new TransportError(`Request timed out after ${opts.timeoutMs}ms`, { cause, timedOut: true });
    }
    if (req.signal?.aborted) throw new TransportError('Request was aborted', { cause });
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new TransportError(`Request failed: ${message}`, { cause });
  } finally {
    linked.clear();
  }
}
