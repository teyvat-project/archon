// Manual smoke test against the public api.natsuneko.com (unauthenticated GETs only).
//
//   node --experimental-strip-types scripts/live-smoke.ts
//
// Generates the SDK from examples/natsuneko/archon.config.ts into a temp directory, then calls three
// GET operations that need neither credentials nor required parameters and checks for HTTP 200 and a
// defined `data`. Exits non-zero if any call fails.
//
// The Archon sources use `.js`-suffixed relative imports that Node's type stripping cannot resolve to
// `.ts` files, so the sources (and the generated SDK) are loaded through jiti.
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IROperation, UserConfig } from '../packages/archon/src/index.ts';

const repoPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
// Call up to COUNT operations. The natsuneko spec currently has only MIN_COUNT usable ones (one declares
// `security: []` and works, one has optional auth; the other no-auth GETs either need parameters or are in
// KNOWN_SPEC_MISMATCHES), so fewer than COUNT is tolerated down to MIN_COUNT, with a notice.
const COUNT = 3;
const MIN_COUNT = 2;

/**
 * Operations whose live behavior contradicts the spec, keyed by operation id. They are skipped (and
 * reported) instead of failing the smoke, so a red run always means a regression in the generator or SDK.
 * Remove an entry once the upstream spec or API is fixed.
 */
const KNOWN_SPEC_MISMATCHES: Record<string, string> = {
  'GET /feature-flags/v1/me': 'spec declares no security, live API returns 401',
};

// jiti is a dependency of packages/archon, not of the workspace root.
const { createJiti } = createRequire(repoPath('packages/archon/package.json'))('jiti') as typeof import('jiti');
const jiti = createJiti(import.meta.url, {
  alias: {
    'archon/plugins': repoPath('packages/archon/src/plugins.ts'),
    archon: repoPath('packages/archon/src/index.ts'),
  },
});

const archon = await jiti.import<typeof import('../packages/archon/src/index.ts')>(repoPath('packages/archon/src/index.ts'));
const { loadInput } = await jiti.import<typeof import('../packages/archon/src/loader/load.ts')>(
  repoPath('packages/archon/src/loader/load.ts'),
);

const exampleDir = repoPath('examples/natsuneko');
// Loaded through our aliased jiti so the config's `archon` / `archon/plugins` imports resolve to the sources
// (the package entry points need a prior `pnpm -F archon build`).
const userConfig = await jiti.import<UserConfig>(join(exampleDir, 'archon.config.ts'), { default: true });

const outDir = await mkdtemp(join(tmpdir(), 'archon-live-smoke-'));
let failures = 0;

try {
  // 1. Generate with the example config, redirecting the output to a temp directory.
  const config = { ...userConfig, output: { path: outDir, clean: true } };
  await archon.generate(config, { cwd: exampleDir });
  console.log(`generated SDK into ${outDir}`);

  // 2. Pick operations from the IR: GET, no (or optional) auth, no required parameters / body.
  const diagnostics = new archon.Diagnostics();
  const doc = await loadInput(userConfig.input, { cwd: exampleDir, diagnostics });
  const ir = archon.parseDocument(doc, { diagnostics });
  const callable = (op: IROperation) =>
    op.method === 'get' &&
    !op.deprecated &&
    !op.parameters.some((p) => p.required) &&
    !op.requestBody?.required &&
    op.responses.some((r) => r.status === 200);
  const noAuth = (op: IROperation) => op.security.length === 0;
  const optionalAuth = (op: IROperation) => op.security.some((s) => s.schemes.length === 0);
  const skipped = ir.operations.filter((op) => callable(op) && op.id in KNOWN_SPEC_MISMATCHES);
  for (const op of skipped) console.log(`skip ${op.id}: ${KNOWN_SPEC_MISMATCHES[op.id]}`);
  const candidates = ir.operations.filter((op) => callable(op) && !(op.id in KNOWN_SPEC_MISMATCHES));
  // `security: []` operations first; if the spec has fewer than COUNT, fall back to optional-auth ones (`{}`).
  const picked = [...candidates.filter(noAuth), ...candidates.filter((op) => !noAuth(op) && optionalAuth(op))].slice(0, COUNT);
  if (picked.length < MIN_COUNT) throw new Error(`Only ${picked.length} suitable operations found (need at least ${MIN_COUNT})`);
  if (picked.length < COUNT) console.log(`note: only ${picked.length} suitable operations exist (wanted ${COUNT})`);

  // 3. Call them through the generated SDK with the default client (baseUrl = servers[0]).
  const sdk = await jiti.import<Record<string, unknown>>(join(outDir, 'ts', 'index.ts'));
  const client = (sdk['createApiClient'] as () => unknown)();

  for (const op of picked) {
    const fn = archon.toCase(op.name, 'camelCase');
    const label = `${op.id} (${fn}, security: ${noAuth(op) ? '[]' : 'optional'})`;
    try {
      const call = sdk[fn] as ((o: { client: unknown }) => Promise<{ data?: unknown; error?: unknown; response: Response }>) | undefined;
      if (typeof call !== 'function') throw new Error(`generated SDK has no function "${fn}"`);
      const { data, error, response } = await call({ client });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(error ?? null)}`);
      if (data === undefined) throw new Error('data is undefined');
      console.log(`ok   ${label} -> ${response.status} ${describe(data)}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${label}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }
} catch (e) {
  failures++;
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await rm(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('live smoke passed');

/** A short shape summary of a decoded response body. */
function describe(data: unknown): string {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data !== null && typeof data === 'object') {
    const keys = Object.keys(data);
    return `object{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', ...' : ''}}`;
  }
  return typeof data;
}
