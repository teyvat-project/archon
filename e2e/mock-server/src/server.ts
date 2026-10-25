import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CREDENTIALS, errorReply, json, type Received, type Reply, type Route, type ServerState } from './http.js';
import { authRoutes } from './routes/auth.js';
import { echo, echoRoutes } from './routes/echo.js';
import { errorRoutes } from './routes/errors.js';
import { flakyRoutes } from './routes/flaky.js';
import { nodeRoutes } from './routes/nodes.js';
import { oauthRoutes } from './routes/oauth.js';
import { redirectRoutes } from './routes/redirect.js';
import { responseRoutes } from './routes/responses.js';
import { unionRoutes } from './routes/unions.js';

export { CREDENTIALS, TOKEN_LIFETIME_S } from './http.js';
export type { Echo } from './routes/echo.js';

export interface MockServer {
  /** Origin of the server implementing fixtures/specs/edge-cases.yaml, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Origin of an echo-only server on another port (for cross-origin redirects). */
  secondaryUrl: string;
  close(): Promise<void>;
}

const routes: Route[] = [
  ...echoRoutes,
  ...responseRoutes,
  ...unionRoutes,
  ...errorRoutes,
  ...authRoutes,
  ...oauthRoutes,
  ...flakyRoutes,
  ...redirectRoutes,
  ...nodeRoutes,
];

async function receive(req: IncomingMessage): Promise<Received> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const target = req.url ?? '/';
  const q = target.indexOf('?');
  return {
    method: req.method ?? 'GET',
    path: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? '' : target.slice(q + 1),
    headers: req.headers,
    body: Buffer.concat(chunks),
  };
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, reply.headers);
  res.end(reply.body);
}

type Handler = (req: Received) => Reply | Promise<Reply>;

function primaryHandler(state: ServerState): Handler {
  return async (req) => {
    if (req.method === 'GET' && req.path === '/__stats') return json(200, state.stats);
    state.stats.requests[req.path] = (state.stats.requests[req.path] ?? 0) + 1;
    for (const route of routes) {
      const match = route.path.exec(req.path);
      if (match === null) continue;
      if (route.method !== '*' && route.method !== req.method) return errorReply(405, 'Method not allowed');
      return route.handle(req, match, state);
    }
    return errorReply(404, `No route for ${req.method} ${req.path}`);
  };
}

async function listen(handler: Handler, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    receive(req)
      .then(handler)
      .then(
        (reply) => send(res, reply),
        (error: unknown) => send(res, errorReply(500, error instanceof Error ? error.message : String(error))),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port: actual } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${actual}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // fetch keeps connections alive; drop them so close() does not wait for their idle timeout.
    server.closeAllConnections();
  });
}

/** Starts the edge-cases mock server (on `opts.port`, default a random port) and the echo-only secondary server. */
export async function startMockServer(opts: { port?: number } = {}): Promise<MockServer> {
  const secondary = await listen((req) => json(200, echo(req)), 0);
  const state: ServerState = {
    secondaryUrl: secondary.url,
    stats: { tokensIssued: 0, requests: {} },
    accessTokens: new Map(),
    refreshTokens: new Set([CREDENTIALS.oauth2.refreshToken]),
    flakyAttempts: new Map(),
  };
  let primary: { server: Server; url: string };
  try {
    primary = await listen(primaryHandler(state), opts.port ?? 0);
  } catch (error) {
    await closeServer(secondary.server);
    throw error;
  }
  return {
    url: primary.url,
    secondaryUrl: secondary.url,
    close: async () => {
      await Promise.all([closeServer(primary.server), closeServer(secondary.server)]);
    },
  };
}
