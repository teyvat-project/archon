import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchonError } from '../src/diagnostics.js';
import type { Diagnostic } from '../src/diagnostics.js';
import { generate } from '../src/generate.js';
import { definePlugin } from '../src/plugin/define.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.0.0' },
  paths: {
    '/pets': {
      get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } },
    },
  },
};

const fake = (name: string) =>
  definePlugin<{ output?: string }, void>({
    name,
    defaults: {},
    generate(ctx) {
      ctx.emit('ops.txt', `${name}: ${ctx.ir.operations.map((o) => o.name).join(',')}`);
    },
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archon-generate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('generate', () => {
  it('runs full pipeline with a fake plugin and writes files', async () => {
    const result = await generate({ input: spec, output: 'sdk', plugins: [fake('fake')()] }, { cwd: dir });

    const file = join(dir, 'sdk', 'fake', 'ops.txt');
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.files).toEqual([file]);
    expect(result.jobs[0]?.files.every((f) => isAbsolute(f))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('fake: listPets');
  });

  it('applies parser.patch and passes logger diagnostics through', async () => {
    const logged: Diagnostic[] = [];
    const result = await generate(
      {
        input: spec,
        output: 'sdk',
        plugins: [fake('fake')()],
        parser: { patch: { operations: { 'GET /pets': (op) => (op.operationId = 'patchedName') } } },
      },
      { cwd: dir, logger: (d) => logged.push(d) },
    );
    expect(await readFile(result.jobs[0]!.files[0]!, 'utf8')).toBe('fake: patchedName');
    expect(logged).toEqual([]);
  });

  it('runs one job per config and returns per-job results', async () => {
    const result = await generate(
      [
        { input: spec, output: 'a', plugins: [fake('fake')()] },
        { input: spec, output: 'b', plugins: [fake('fake')()] },
      ],
      { cwd: dir },
    );
    expect(result.jobs.map((j) => j.files)).toEqual([[join(dir, 'a/fake/ops.txt')], [join(dir, 'b/fake/ops.txt')]]);
  });

  it('strict fails on warnings before writing', async () => {
    const logged: Diagnostic[] = [];
    const config = {
      input: spec,
      output: 'sdk',
      plugins: [fake('fake')()],
      parser: { patch: { schemas: { Missing: () => undefined } } },
    };

    const err = await generate(config, { cwd: dir, strict: true, logger: (d) => logged.push(d) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArchonError);
    expect((err as ArchonError).code).toBe('strict-warnings');
    expect(existsSync(join(dir, 'sdk'))).toBe(false);
    expect(logged.some((d) => d.code === 'patch-target-missing')).toBe(true);

    // strict でなければ警告付きで書き出される
    const ok = await generate(config, { cwd: dir });
    expect(ok.jobs[0]?.diagnostics.some((d) => d.level === 'warn')).toBe(true);
    expect(existsSync(join(dir, 'sdk', 'fake', 'ops.txt'))).toBe(true);
  });

  it('plugins option limits executed plugins', async () => {
    const result = await generate(
      { input: spec, output: 'sdk', plugins: [fake('one')(), fake('two')()] },
      { cwd: dir, plugins: ['two'] },
    );
    expect(result.jobs[0]?.files).toEqual([join(dir, 'sdk/two/ops.txt')]);
    expect(existsSync(join(dir, 'sdk', 'one'))).toBe(false);
  });

  it('only streams info diagnostics to the logger when verbose', async () => {
    const quiet: Diagnostic[] = [];
    const loud: Diagnostic[] = [];
    const config = { input: spec, output: 'sdk', plugins: [fake('fake')()] };
    await generate(config, { cwd: dir, logger: (d) => quiet.push(d) });
    await generate(config, { cwd: dir, verbose: true, logger: (d) => loud.push(d) });
    expect(quiet.filter((d) => d.level === 'info')).toEqual([]);
    expect(loud.length).toBeGreaterThanOrEqual(quiet.length);
  });
});
