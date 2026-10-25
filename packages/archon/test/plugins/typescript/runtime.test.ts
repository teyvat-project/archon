import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArchonError } from '../../../src/diagnostics.js';
import { resolveRuntimeDir } from '../../../src/plugins/typescript/runtime.js';
import { arr, dateTime, file, generate, json, obj, operation, petstore, prop, ref, response } from './helpers.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/typescript/src', import.meta.url));
const runtimeSources = readdirSync(repoRuntime).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('typescript plugin: vendored runtime', () => {
  it('copies runtime files and rewrites import extensions', async () => {
    const { files } = await generate(petstore(), { importExtension: '' });
    const core = [...files.keys()].filter((p) => p.startsWith('core/')).sort();
    expect(core).toEqual(runtimeSources.map((f) => `core/${f}`).sort());

    const client = file(files, 'core/client.ts');
    expect(client.startsWith('// Generated header\n\n')).toBe(true);
    expect(client).toContain("from './types';");
    expect(client).not.toMatch(/from '\.\/[^']*\.js'/);
    expect(file(files, 'core/index.ts')).toContain("export * from './types';");

    // 拡張子以外は元のソースのまま
    const original = readFileSync(join(repoRuntime, 'client.ts'), 'utf8');
    expect(client.slice('// Generated header\n\n'.length)).toBe(original.replace(/(from '\.\/[^']*)\.js'/g, "$1'"));
  });

  it('keeps .js and rewrites to .ts per importExtension', async () => {
    const js = file((await generate(petstore())).files, 'core/index.ts');
    expect(js).toContain("export * from './types.js';");
    const ts = file((await generate(petstore(), { importExtension: '.ts' })).files, 'core/index.ts');
    expect(ts).toContain("export * from './types.ts';");
    expect(ts).toContain("export { base64Encode } from './base64.ts';");
  });

  it('resolveRuntimeDir finds repo runtimes in dev', () => {
    expect(resolveRuntimeDir('typescript')).toBe(repoRuntime);
    expect(() => resolveRuntimeDir('cobol')).toThrow(
      expect.objectContaining({ name: 'ArchonError', code: 'runtime-missing' }) as ArchonError,
    );
  });

  it('resolveRuntimeDir prefers repo runtimes over a stale build copy when loaded from src', () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), 'archon-pkg-'));
    try {
      // packages/archon/src/plugins/typescript/runtime.ts に相当するレイアウト（repo は <pkgRoot>/../..）
      const repo = join(pkgRoot, 'repo');
      const pkg = join(repo, 'packages', 'archon');
      for (const dir of [join(pkg, 'src', 'plugins', 'typescript'), join(pkg, 'runtimes', 'typescript', 'src'), join(repo, 'runtimes', 'typescript', 'src')]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(join(pkg, 'package.json'), '{}');
      writeFileSync(join(pkg, 'runtimes', 'typescript', 'src', 'index.ts'), '');
      writeFileSync(join(repo, 'runtimes', 'typescript', 'src', 'index.ts'), '');
      const from = pathToFileURL(join(pkg, 'src', 'plugins', 'typescript', 'runtime.ts')).href;
      expect(resolveRuntimeDir('typescript', from)).toBe(join(repo, 'runtimes', 'typescript', 'src'));

      // repo に無ければ build コピーを使う
      rmSync(join(repo, 'runtimes'), { recursive: true });
      expect(resolveRuntimeDir('typescript', from)).toBe(join(pkg, 'runtimes', 'typescript', 'src'));
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  it('resolveRuntimeDir uses only the packaged runtimes when loaded from dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-dist-'));
    try {
      // <project>/node_modules/@natsuneko-laboratory/archon/dist/plugins.js。<pkgRoot>/../.. に無関係な runtimes がある
      const project = join(root, 'project');
      const pkg = join(project, 'node_modules', '@natsuneko-laboratory', 'archon');
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      mkdirSync(join(pkg, 'runtimes', 'typescript', 'src'), { recursive: true });
      mkdirSync(join(project, 'runtimes', 'typescript', 'src'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), '{}');
      writeFileSync(join(pkg, 'runtimes', 'typescript', 'src', 'index.ts'), '');
      writeFileSync(join(project, 'runtimes', 'typescript', 'src', 'index.ts'), '');
      const from = pathToFileURL(join(pkg, 'dist', 'plugins.js')).href;
      expect(resolveRuntimeDir('typescript', from)).toBe(join(pkg, 'runtimes', 'typescript', 'src'));

      rmSync(join(pkg, 'runtimes'), { recursive: true });
      expect(() => resolveRuntimeDir('typescript', from)).toThrow(
        expect.objectContaining({ name: 'ArchonError', code: 'runtime-missing' }) as ArchonError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generated SDK compiles with tsc', async () => {
    const ir = petstore();
    ir.schemas.set('Client', obj([prop('id', ref('Pet'), true), prop('seen', arr(dateTime))]));
    ir.operations.push(
      operation('GET /clients/{id}', 'getClient', {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            deprecated: false,
            schema: { kind: 'integer', nullable: false },
            style: 'simple',
            explode: false,
            allowReserved: false,
          },
        ],
        responses: [response(200, [json(ref('Client'))]), response(202, [json(ref('Pet'))])],
      }),
    );
    const variants = [
      {
        dir: 'default',
        opts: {},
        usage: [
          "import { client, createApiClient, getClient, listPets, showPetById } from './index.js';",
          "import type { ApiError, Client2, GetClientResponse, Pet } from './index.js';",
          '',
          'export async function usage(): Promise<void> {',
          "  client.setConfig({ auth: { bearerAuth: 'token' } });",
          "  const local = createApiClient({ baseUrl: 'http://localhost' });",
          '  const listed = await listPets();',
          '  const pets: Pet[] | undefined = listed.data;',
          "  const one = await showPetById({ client: local, path: { petId: '1' }, throwOnError: true });",
          '  const pet: Pet = one.data;',
          '  const got = await getClient({ path: { id: 1 } });',
          '  const value: GetClientResponse | undefined = got.data;',
          '  const c: Client2 | Pet | undefined = value;',
          '  const err: ApiError<unknown> | undefined = got.error;',
          '  void [pets, pet, c, err];',
          '}',
        ],
      },
      {
        dir: 'class-dates',
        opts: { sdk: { style: 'class' as const }, dates: 'Date' as const },
        usage: [
          "import { Default, Pets } from './index.js';",
          "import type { Pet } from './index.js';",
          '',
          'export async function usage(): Promise<void> {',
          "  const one = await Pets.showPetById({ path: { petId: '1' } });",
          '  const created: Date | undefined = one.data?.createdAt;',
          '  const health = await Default.getHealth();',
          '  const p: Pet | undefined = one.data;',
          '  void [created, health, p];',
          '}',
        ],
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'archon-ts-sdk-'));
    try {
      for (const variant of variants) {
        const { files } = await generate(ir, variant.opts);
        for (const [path, content] of files) {
          const target = join(dir, variant.dir, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
        writeFileSync(join(dir, variant.dir, 'usage.ts'), `${variant.usage.join('\n')}\n`);
      }

      const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
      for (const variant of variants) {
        const result = spawnSync(tsc, ['-p', join(dir, variant.dir)], { cwd: dir, encoding: 'utf8' });
        expect(result.stdout + result.stderr).toBe('');
        expect(result.status).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
