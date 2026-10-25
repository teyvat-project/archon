// Runtime-agnostic smoke test of the generated SDK (no vitest, only web-standard APIs), run under Bun
// and Deno by scripts/runtime-smoke.mjs. Usage: <runtime> smoke/smoke.ts <mock-server-url>
import { ApiError, createApiClient, echoJson, getBinary, getError, getText, listShapes } from '../generated/default/index.js';

// Bun and Deno both expose Node's `process` global, but Deno's type-check may not have @types/node.
const { argv } = (globalThis as unknown as { process: { argv: string[] } }).process;
const baseUrl = argv[argv.length - 1]!;
const client = createApiClient({ baseUrl });

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
}

const text = await getText({ client, throwOnError: true });
check(text.data === 'hello, archon', 'text/plain decodes to a string');

const binary = await getBinary({ client, throwOnError: true });
const bytes = new Uint8Array(await binary.data.arrayBuffer());
check(bytes.length === 256 && bytes[0] === 0x00 && bytes[255] === 0xff, 'octet-stream decodes to a Blob');

const echoed = await echoJson({ client, throwOnError: true, body: { name: 'archon', count: 1, tags: [] } });
check(echoed.data.method === 'POST' && echoed.data.contentType === 'application/json', 'JSON body is sent');

const shapes = await listShapes({ client, throwOnError: true });
check(shapes.data.length === 3 && shapes.data[0]!.kind === 'circle', 'union response decodes');

const notFound = await getError({ client, path: { status: 404 } });
check(notFound.error instanceof ApiError && notFound.error.status === 404, 'non-2xx resolves to an ApiError');

console.log('runtime smoke passed');
