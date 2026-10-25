// Generates the SDKs, starts the mock server on Node and runs smoke/smoke.ts under another runtime against it.
//
//   node scripts/runtime-smoke.mjs bun|deno
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const RUNTIMES = {
  bun: ['bun', 'smoke/smoke.ts'],
  // The generated SDK uses `.js`-suffixed imports of `.ts` files (TypeScript's NodeNext convention); Deno only
  // maps those with sloppy imports. `--check` also type-checks the SDK with Deno's own TypeScript.
  deno: ['deno', 'run', '--check', '--sloppy-imports', '--allow-net=127.0.0.1', 'smoke/smoke.ts'],
};

const command = RUNTIMES[process.argv[2]];
if (command === undefined) {
  console.error(`usage: node scripts/runtime-smoke.mjs ${Object.keys(RUNTIMES).join('|')}`);
  process.exit(2);
}

const archonSource = (file) => fileURLToPath(new URL(`../../../packages/archon/src/${file}`, import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { '@natsuneko-laboratory/archon/plugins': archonSource('plugins.ts'), '@natsuneko-laboratory/archon': archonSource('index.ts') },
});
const { generateSdks } = await jiti.import('../global-setup.ts');
const { startMockServer } = await jiti.import('@natsuneko-laboratory/archon-e2e-mock-server');

await generateSdks();
const server = await startMockServer();
try {
  const [bin, ...args] = command;
  // The mock server runs on this process's event loop, so the child must be awaited asynchronously.
  const code = await new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, server.url], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  await server.close();
}
