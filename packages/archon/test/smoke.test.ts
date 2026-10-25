import { expect, test } from 'vitest';
import { version } from '../src/index.js';

test('exposes a semver version', () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});
