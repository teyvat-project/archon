import { defineConfig } from 'archon';
import { typescript } from 'archon/plugins';

export default defineConfig({
  input: 'https://api.natsuneko.com/openapi.json',
  output: './sdk',
  plugins: [typescript({ output: 'ts' })],
});
