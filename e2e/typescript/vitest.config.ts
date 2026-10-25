import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const archonSource = (file: string) => fileURLToPath(new URL(`../../packages/archon/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // `archon` is consumed from source so the suite needs no build step.
    alias: [
      { find: /^archon$/, replacement: archonSource('index.ts') },
      { find: /^archon\/plugins$/, replacement: archonSource('plugins.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./global-setup.ts'],
    // Every file talks to the same mock server, whose counters (`/__stats`) are compared before and after.
    fileParallelism: false,
  },
});
