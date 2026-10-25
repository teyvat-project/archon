// Starts the mock server, generates the SDK and runs the JUnit suite against it (archon.e2e.* Gradle properties).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { generateSdk } from './generate.mjs';

const jiti = createJiti(import.meta.url);
const { startMockServer } = await jiti.import(fileURLToPath(new URL('../../mock-server/src/server.ts', import.meta.url)));
const project = fileURLToPath(new URL('..', import.meta.url));
const gradlew = fileURLToPath(new URL(`../../../runtimes/kotlin/gradlew${process.platform === 'win32' ? '.bat' : ''}`, import.meta.url));

await generateSdk();
const server = await startMockServer();
let code = 1;
try {
  code = await new Promise((resolve) => {
    const args = ['-p', project, 'test', '--console=plain', `-Parchon.e2e.baseUrl=${server.url}`, `-Parchon.e2e.secondaryUrl=${server.secondaryUrl}`, ...process.argv.slice(2)];
    const child = spawn(gradlew, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (status) => resolve(status ?? 1));
    child.on('error', () => resolve(1));
  });
} finally {
  await server.close();
}
process.exit(code);
