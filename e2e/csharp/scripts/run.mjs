// Starts the mock server, generates the SDK and runs the xUnit suite against it (ARCHON_E2E_* variables).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { generateSdk } from './generate.mjs';

const jiti = createJiti(import.meta.url);
const { startMockServer } = await jiti.import(fileURLToPath(new URL('../../mock-server/src/server.ts', import.meta.url)));
const tests = fileURLToPath(new URL('../tests', import.meta.url));

await generateSdk();
const server = await startMockServer();
let code = 1;
try {
  code = await new Promise((resolve) => {
    const child = spawn('dotnet', ['test', tests, '--nologo', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ARCHON_E2E_BASE_URL: server.url,
        ARCHON_E2E_SECONDARY_URL: server.secondaryUrl,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      },
    });
    child.on('close', (status) => resolve(status ?? 1));
    child.on('error', () => resolve(1));
  });
} finally {
  await server.close();
}
process.exit(code);
