import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  describe('invalid configs', () => {
    const invalid = async (name: string, content: string) => {
      const dir = await mkdtemp(join(tmpdir(), 'archon-config-'));
      try {
        await writeFile(join(dir, name), content);
        return await loadConfigFile({ cwd: dir, file: name }).catch((e: unknown) => e);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    const expectInvalid = (err: unknown, name: string) => {
      expect(err).toBeInstanceOf(ArchonError);
      expect((err as ArchonError).code).toBe('config-invalid');
      expect((err as ArchonError).message).toContain(name);
    };

    it('rejects malformed JSON', async () => {
      expectInvalid(await invalid('bad.json', '{ "input": '), 'bad.json');
    });

    it('rejects a module that fails to load', async () => {
      expectInvalid(await invalid('broken.config.mjs', 'export default {;'), 'broken.config.mjs');
      expectInvalid(await invalid('throws.config.mjs', 'throw new Error("boom");'), 'throws.config.mjs');
    });

    it('rejects configs that are not objects with input and output', async () => {
      expectInvalid(await invalid('null.json', 'null'), 'null.json');
      expectInvalid(await invalid('string.json', '"spec.yaml"'), 'string.json');
      expectInvalid(await invalid('no-output.json', '{ "input": "spec.yaml" }'), 'no-output.json');
      expectInvalid(await invalid('no-input.config.mjs', 'export default { output: "out" };'), 'no-input.config.mjs');
      expectInvalid(
        await invalid('multi.config.mjs', 'export default [{ input: "a.yaml", output: "a" }, 42];'),
        'multi.config.mjs',
      );
    });
  });
});
