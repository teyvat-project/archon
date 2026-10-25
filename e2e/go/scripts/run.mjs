// Starts the mock server, generates the SDK and runs the Go test suite against it (ARCHON_E2E_* variables).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { generateSdk } from './generate.mjs';

const jiti = createJiti(import.meta.url);
const { startMockServer } = await jiti.import(fileURLToPath(new URL('../../mock-server/src/server.ts', import.meta.url)));
const project = fileURLToPath(new URL('..', import.meta.url));

await generateSdk();
const server = await startMockServer();
let code = 1;
try {
  code = await new Promise((resolve) => {
    const env = { ...process.env, ARCHON_E2E_BASE_URL: server.url, ARCHON_E2E_SECONDARY_URL: server.secondaryUrl };
    const child = spawn('go', ['test', '-count=1', ...process.argv.slice(2), './...'], { cwd: project, env, stdio: 'inherit' });
    child.on('close', (status) => resolve(status ?? 1));
    child.on('error', () => resolve(1));
  });
} finally {
  await server.close();
}
process.exit(code);
