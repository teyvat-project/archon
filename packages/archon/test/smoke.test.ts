import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { version } from '../src/index.js';

test('exposes a semver version', () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});

test('version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  expect(version).toBe(pkg['version']);
});

test('package.json builds before packing and declares the supported Node versions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
    engines?: Record<string, string>;
  };
  expect(pkg.scripts['prepack']).toBe('pnpm run build');
  expect(pkg.engines).toEqual({ node: '>=18' });
});
