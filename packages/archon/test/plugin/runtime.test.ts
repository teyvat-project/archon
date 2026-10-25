import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeDir } from '../../src/plugin/runtime.js';

describe('resolveRuntimeDir', () => {
  it('finds the csharp runtime by marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-rt-'));
    try {
      const repo = join(root, 'repo');
      const pkg = join(repo, 'packages', 'archon');
      mkdirSync(join(pkg, 'src', 'plugin'), { recursive: true });
      mkdirSync(join(repo, 'runtimes', 'csharp', 'src'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), '{}');
      const from = pathToFileURL(join(pkg, 'src', 'plugin', 'runtime.ts')).href;

      // index.ts is not the marker for C#: without ApiClientCore.cs the runtime is missing
      writeFileSync(join(repo, 'runtimes', 'csharp', 'src', 'index.ts'), '');
      expect(() => resolveRuntimeDir('csharp', { marker: 'ApiClientCore.cs', fromUrl: from })).toThrow(
        expect.objectContaining({ code: 'runtime-missing' }),
      );

      writeFileSync(join(repo, 'runtimes', 'csharp', 'src', 'ApiClientCore.cs'), '');
      expect(resolveRuntimeDir('csharp', { marker: 'ApiClientCore.cs', fromUrl: from })).toBe(
        join(repo, 'runtimes', 'csharp', 'src'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
