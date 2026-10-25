// Generates the SDKs under generated/ (as the global setup does) so `tsc` can type-check the suite.
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const archonSource = (file) => fileURLToPath(new URL(`../../../packages/archon/src/${file}`, import.meta.url));

const jiti = createJiti(import.meta.url, {
  alias: { 'archon/plugins': archonSource('plugins.ts'), archon: archonSource('index.ts') },
});
const { generateSdks } = await jiti.import('../global-setup.ts');
await generateSdks();
