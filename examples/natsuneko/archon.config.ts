import { defineConfig } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: 'https://api.natsuneko.com/openapi.json',
  output: './sdk',
  plugins: [typescript({ output: 'ts' })],
});
