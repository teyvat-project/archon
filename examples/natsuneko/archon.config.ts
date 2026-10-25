import { defineConfig } from '@natsuneko-laboratory/archon';
import { csharp, kotlin, swift, typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: 'https://api.natsuneko.com/openapi.json',
  output: './sdk',
  plugins: [
    typescript({ output: 'ts' }),
    csharp({ output: 'csharp', namespace: 'Natsuneko.Api' }),
    kotlin({ output: 'kotlin', packageName: 'com.natsuneko.api' }),
    swift({ output: 'swift', moduleName: 'NatsunekoApi' }),
  ],
});
