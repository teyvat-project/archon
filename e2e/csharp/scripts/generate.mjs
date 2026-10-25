// Generates the C# SDK for fixtures/specs/edge-cases.yaml into generated/EdgeCases (consumed from archon's source).
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const archonSource = (file) => fileURLToPath(new URL(`../../../packages/archon/src/${file}`, import.meta.url));
const jiti = createJiti(import.meta.url);

export async function generateSdk() {
  const { generate } = await jiti.import(archonSource('index.ts'));
  const { csharp } = await jiti.import(archonSource('plugins.ts'));
  await generate(
    {
      input: 'fixtures/specs/edge-cases.yaml',
      output: 'e2e/csharp/generated',
      plugins: [csharp({ output: 'EdgeCases', namespace: 'Archon.EdgeCases' })],
    },
    { cwd: repoRoot },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generateSdk();
