import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';

const spec = `openapi: 3.0.3
info: { title: Pets, version: '1' }
paths:
  /pets:
    get:
      operationId: listPets
      responses: { '200': { description: ok } }
`;

const fakePlugin = (name: string) => `{
  name: '${name}',
  options: {},
  definition: { name: '${name}', defaults: {}, generate(ctx) { ctx.emit('ops.txt', '${name}'); } },
}`;

let dir: string;
let stderr: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archon-cli-'));
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const argv = (...args: string[]) => ['node', 'archon', ...args];

describe('cli generate', () => {
  it('exits 0 and writes files; --plugin is repeatable', async () => {
    await writeFile(join(dir, 'spec.yaml'), spec);
    await writeFile(
      join(dir, 'archon.config.mjs'),
      `export default { input: './spec.yaml', output: './sdk', plugins: [${fakePlugin('one')}, ${fakePlugin('two')}, ${fakePlugin('three')}] };`,
    );

    expect(await runCli(argv('generate', '--plugin', 'one', '--plugin', 'two'))).toBe(0);
    expect(existsSync(join(dir, 'sdk/one/ops.txt'))).toBe(true);
    expect(existsSync(join(dir, 'sdk/two/ops.txt'))).toBe(true);
    expect(existsSync(join(dir, 'sdk/three'))).toBe(false);
  });

  it('resolves paths relative to the config file with -c', async () => {
    await writeFile(join(dir, 'spec.yaml'), spec);
    await writeFile(
      join(dir, 'custom.config.mjs'),
      `export default { input: './spec.yaml', output: './sdk', plugins: [${fakePlugin('one')}] };`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());

    expect(await runCli(argv('generate', '-c', join(dir, 'custom.config.mjs')))).toBe(0);
    expect(await readFile(join(dir, 'sdk/one/ops.txt'), 'utf8')).toBe('one');
  });

  it('exits 1 and prints code on ArchonError', async () => {
    await writeFile(join(dir, 'archon.config.json'), JSON.stringify({ input: './missing.yaml', output: './sdk' }));

    expect(await runCli(argv('generate'))).toBe(1);
    expect(stderr).toMatch(/error input-not-found: Input file not found/);
  });

  it('exits 1 when no config exists', async () => {
    expect(await runCli(argv('generate'))).toBe(1);
    expect(stderr).toContain('config-not-found');
  });

  it('prints warnings as `level code: message` and --strict exits 1', async () => {
    await writeFile(join(dir, 'spec.yaml'), spec);
    await writeFile(join(dir, 'archon.config.json'), JSON.stringify({ input: './spec.yaml', output: './sdk' }));

    expect(await runCli(argv('generate'))).toBe(0);
    expect(stderr).toMatch(/^warn no-plugins: /m);

    stderr = '';
    expect(await runCli(argv('generate', '--strict'))).toBe(1);
    expect(stderr).toContain('strict-warnings');
  });

  it('prints the stack and exits 1 on unexpected exceptions', async () => {
    await writeFile(join(dir, 'openapi.yaml'), spec);
    await writeFile(
      join(dir, 'archon.config.mjs'),
      `export default { input: 'openapi.yaml', output: 'out', plugins: [{
        name: 'boom', options: {},
        definition: { name: 'boom', defaults: {}, generate() { throw new TypeError('boom'); } },
      }] };`,
    );
    expect(await runCli(argv('generate'))).toBe(1);
    expect(stderr).toContain('TypeError');
    expect(stderr).toContain('boom');
  });

  it('reports a config file that fails to load as config-invalid', async () => {
    await writeFile(join(dir, 'archon.config.mjs'), `throw new TypeError('boom');`);
    expect(await runCli(argv('generate'))).toBe(1);
    expect(stderr).toContain('config-invalid');
    expect(stderr).toContain('archon.config.mjs');
    expect(stderr).toContain('TypeError: boom');
  });
});

describe('cli init', () => {
  it('writes template and refuses overwrite', async () => {
    expect(await runCli(argv('init'))).toBe(0);
    const text = await readFile(join(dir, 'archon.config.ts'), 'utf8');
    expect(text).toContain(`import { defineConfig } from '@natsuneko-laboratory/archon';`);
    expect(text).toContain(`import { typescript } from '@natsuneko-laboratory/archon/plugins';`);
    expect(text).toContain(`input: './openapi.yaml'`);
    expect(text).toContain('plugins: [typescript()]');

    await writeFile(join(dir, 'archon.config.ts'), 'custom');
    stderr = '';
    expect(await runCli(argv('init'))).toBe(1);
    expect(await readFile(join(dir, 'archon.config.ts'), 'utf8')).toBe('custom');
    expect(stderr).toContain('archon.config.ts');
  });
});

describe('cli misc', () => {
  it('prints help and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCli(argv('--help'))).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('generate');
  });

  it('exits 1 on unknown command', async () => {
    expect(await runCli(argv('bogus'))).toBe(1);
    expect(stderr).toContain('bogus');
  });
});
