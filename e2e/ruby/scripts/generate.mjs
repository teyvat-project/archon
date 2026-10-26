// Generates the Ruby SDK for fixtures/specs/edge-cases.yaml into generated/edge_cases (consumed from archon's source).
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const archonSource = (file) => fileURLToPath(new URL(`../../../packages/archon/src/${file}`, import.meta.url));
const jiti = createJiti(import.meta.url);

export async function generateSdk() {
  const { generate } = await jiti.import(archonSource('index.ts'));
  const { ruby } = await jiti.import(archonSource('plugins.ts'));
  await generate(
    {
      input: 'fixtures/specs/edge-cases.yaml',
      output: 'e2e/ruby/generated',
      plugins: [ruby({ output: 'edge_cases', gemName: 'edge_cases', moduleName: 'EdgeCases' })],
    },
    { cwd: repoRoot },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generateSdk();
