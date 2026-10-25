import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/plugins.ts', 'src/cli.ts'],
  format: ['esm'],
  // TypeScript 7 ships no compiler API, so declarations are emitted by Oxc (requires isolatedDeclarations-compatible sources).
  dts: { generator: 'oxc' },
  clean: true,
  target: 'node18',
  fixedExtension: false,
});
