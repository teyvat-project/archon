import type { Route } from '../http.js';

const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

export const responseRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/responses\/text$/,
    handle: () => ({ status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'hello, archon' }),
  },
  {
    method: 'GET',
    path: /^\/responses\/binary$/,
    handle: () => ({ status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }),
  },
  { method: 'GET', path: /^\/responses\/empty$/, handle: () => ({ status: 204 }) },
  {
    method: 'GET',
    path: /^\/responses\/empty-json$/,
    handle: () => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '' }),
  },
];
