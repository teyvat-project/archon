import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { ArchonError } from '../../src/diagnostics.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config');

describe('loadConfigFile', () => {
  it('loads ts config via jiti', async () => {
    const configs = await loadConfigFile({ cwd: fixtures });
    expect(configs).toEqual([{ input: 'ts-spec.yaml', output: 'out-ts' }]);
  });

  it('loads json config', async () => {
    const configs = await loadConfigFile({ cwd: fixtures, file: 'archon.config.json' });
    expect(configs).toEqual([{ input: 'json-spec.yaml', output: 'out-json' }]);
  });

  it('returns array for multi-job config', async () => {
    const configs = await loadConfigFile({ cwd: fixtures, file: 'multi.config.mjs' });
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.output)).toEqual(['out-a', 'out-b']);
  });

  it('errors when no config file found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-config-'));
    try {
      const err = await loadConfigFile({ cwd: dir }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArchonError);
      expect((err as ArchonError).code).toBe('config-not-found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('errors when explicit file is missing', async () => {
    const err = await loadConfigFile({ cwd: fixtures, file: 'nope.config.ts' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchonError);
    expect((err as ArchonError).code).toBe('config-not-found');
  });
});
