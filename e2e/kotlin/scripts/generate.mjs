// Generates the Kotlin SDK for fixtures/specs/edge-cases.yaml into generated/EdgeCases (consumed from archon's source).
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const archonSource = (file) => fileURLToPath(new URL(`../../../packages/archon/src/${file}`, import.meta.url));
const jiti = createJiti(import.meta.url);

export async function generateSdk() {
  const { generate } = await jiti.import(archonSource('index.ts'));
  const { kotlin } = await jiti.import(archonSource('plugins.ts'));
  await generate(
    {
      input: 'fixtures/specs/edge-cases.yaml',
      output: 'e2e/kotlin/generated',
      plugins: [kotlin({ output: 'EdgeCases', packageName: 'archon.edgecases', package: { group: 'archon.e2e', name: 'edge-cases' } })],
    },
    { cwd: repoRoot },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generateSdk();
