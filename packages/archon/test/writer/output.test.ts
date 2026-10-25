import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutputConfig } from '../../src/config/types.js';
import { Diagnostics } from '../../src/diagnostics.js';
import { writeOutput } from '../../src/writer/output.js';

let root: string;
let outPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-output-'));
  outPath = join(root, 'out');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const output = (extra: Partial<OutputConfig> = {}): Required<OutputConfig> => ({
  path: outPath,
  clean: true,
  header: (c) => c.defaultValue,
  postProcess: [],
  ...extra,
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('writeOutput', () => {
  it('writes files with nested dirs (strings and bytes)', async () => {
    const diagnostics = new Diagnostics();
    await writeOutput(
      [
        { path: 'ts/a.txt', content: 'hello' },
        { path: 'ts/deep/er/b.bin', content: new Uint8Array([1, 2, 3]) },
      ],
      output(),
      { root, diagnostics, outputDirs: ['ts'] },
    );
    expect(await readFile(join(outPath, 'ts/a.txt'), 'utf8')).toBe('hello');
    expect([...(await readFile(join(outPath, 'ts/deep/er/b.bin')))]).toEqual([1, 2, 3]);
  });

  it('clean removes only emitted plugin dirs', async () => {
    await mkdir(join(outPath, 'ts'), { recursive: true });
    await mkdir(join(outPath, 'other'), { recursive: true });
    await writeFile(join(outPath, 'ts/stale.txt'), 'stale');
    await writeFile(join(outPath, 'other/keep.txt'), 'keep');
    await writeFile(join(outPath, 'top.txt'), 'top');
    await writeOutput([{ path: 'ts/new.txt', content: 'new' }], output(), {
      root,
      diagnostics: new Diagnostics(),
      outputDirs: ['ts'],
    });
    expect(await exists(join(outPath, 'ts/stale.txt'))).toBe(false);
    expect(await readFile(join(outPath, 'ts/new.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(outPath, 'other/keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(outPath, 'top.txt'), 'utf8')).toBe('top');
  });

  it('does not clean when clean is false', async () => {
    await mkdir(join(outPath, 'ts'), { recursive: true });
    await writeFile(join(outPath, 'ts/stale.txt'), 'stale');
    await writeOutput([{ path: 'ts/new.txt', content: 'new' }], output({ clean: false }), {
      root,
      diagnostics: new Diagnostics(),
      outputDirs: ['ts'],
    });
    expect(await exists(join(outPath, 'ts/stale.txt'))).toBe(true);
  });

  it('outputDir "." cleans the whole output path', async () => {
    await mkdir(join(outPath, 'sub'), { recursive: true });
    await writeFile(join(outPath, 'sub/stale.txt'), 'stale');
    await writeFile(join(outPath, 'stale2.txt'), 'stale');
    await writeOutput([{ path: 'a.txt', content: 'a' }], output(), {
      root,
      diagnostics: new Diagnostics(),
      outputDirs: ['.'],
    });
    expect(await readdir(outPath)).toEqual(['a.txt']);
  });

  it('refuses to clean the whole directory when it contains the project root', async () => {
    await writeFile(join(root, 'precious.txt'), 'x');
    await expect(
      writeOutput([{ path: 'a.txt', content: 'a' }], output({ path: root }), {
        root,
        diagnostics: new Diagnostics(),
        outputDirs: ['.'],
      }),
    ).rejects.toMatchObject({ code: 'unsafe-clean' });
    expect(await exists(join(root, 'precious.txt'))).toBe(true);
  });

  it('never deletes outside output.path', async () => {
    await writeFile(join(root, 'outside.txt'), 'x');
    await expect(
      writeOutput([], output(), { root, diagnostics: new Diagnostics(), outputDirs: ['..'] }),
    ).rejects.toMatchObject({ code: 'invalid-output-path' });
    expect(await exists(join(root, 'outside.txt'))).toBe(true);
  });

  it('validates all paths before cleaning anything', async () => {
    await mkdir(join(outPath, 'ts'), { recursive: true });
    await writeFile(join(outPath, 'ts/keep.txt'), 'keep');
    await expect(
      writeOutput([{ path: 'ts/ok.txt', content: 'x' }, { path: '../evil.txt', content: 'x' }], output(), {
        root,
        diagnostics: new Diagnostics(),
        outputDirs: ['ts'],
      }),
    ).rejects.toMatchObject({ code: 'invalid-output-path' });
    expect(await exists(join(outPath, 'ts/keep.txt'))).toBe(true);
    expect(await exists(join(outPath, 'ts/ok.txt'))).toBe(false);
  });

  it('refuses to write files outside output.path', async () => {
    await expect(
      writeOutput([{ path: '../evil.txt', content: 'x' }], output(), {
        root,
        diagnostics: new Diagnostics(),
        outputDirs: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid-output-path' });
    expect(await exists(join(root, 'evil.txt'))).toBe(false);
  });

  it('runs postProcess with {{path}} replaced by the absolute output path', async () => {
    const diagnostics = new Diagnostics();
    await writeOutput([{ path: 'ts/a.txt', content: 'a' }], output({
      postProcess: [
        {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/marker.txt", "done")', '{{path}}'],
        },
      ],
    }), { root, diagnostics, outputDirs: ['ts'] });
    expect(await readFile(join(outPath, 'marker.txt'), 'utf8')).toBe('done');
    expect(diagnostics.hasWarnings()).toBe(false);
  });

  it('replaces {{path}} embedded in an argument and runs commands in order', async () => {
    await writeOutput([{ path: 'a.txt', content: 'a' }], output({
      postProcess: [
        { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "1")', '{{path}}/one.txt'] },
        {
          command: process.execPath,
          args: ['-e', 'const fs=require("node:fs");fs.writeFileSync(process.argv[1], fs.readFileSync(process.argv[2],"utf8")+"2")', '{{path}}/two.txt', '{{path}}/one.txt'],
        },
      ],
    }), { root, diagnostics: new Diagnostics(), outputDirs: ['.'] });
    expect(await readFile(join(outPath, 'two.txt'), 'utf8')).toBe('12');
  });

  it('warns post-process-failed on non-zero exit and continues', async () => {
    const diagnostics = new Diagnostics();
    await writeOutput([{ path: 'a.txt', content: 'a' }], output({
      postProcess: [
        { command: process.execPath, args: ['-e', 'console.error("boom");process.exit(3)'] },
        { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "x")', '{{path}}/after.txt'] },
      ],
    }), { root, diagnostics, outputDirs: [] });
    const warns = diagnostics.entries.filter((e) => e.code === 'post-process-failed');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.level).toBe('warn');
    expect(warns[0]?.message).toContain('3');
    expect(warns[0]?.message).toContain('boom');
    expect(await exists(join(outPath, 'after.txt'))).toBe(true);
  });

  it('warns post-process-failed when the command cannot be spawned', async () => {
    const diagnostics = new Diagnostics();
    await writeOutput([], output({ postProcess: [{ command: 'archon-no-such-command-xyz', args: [] }] }), {
      root,
      diagnostics,
      outputDirs: [],
    });
    expect(diagnostics.entries.map((e) => e.code)).toEqual(['post-process-failed']);
  });

  it('does not interpret arguments through a shell', async () => {
    await writeOutput([], output({
      postProcess: [{ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', '{{path}}/arg.txt', 'a b; $HOME `x`'] }],
    }), { root, diagnostics: new Diagnostics(), outputDirs: [] });
    expect(await readFile(join(outPath, 'arg.txt'), 'utf8')).toBe('a b; $HOME `x`');
  });
});
