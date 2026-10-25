import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/diagnostics.js';
import { generate } from '../../src/generate.js';
import { csharp, kotlin, rust, swift, typescript } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));

/** core/（ランタイムのコピー）は runtime.test.ts で検証するので除く。 */
const EXPECTED_FILES = ['client.gen.ts', 'index.ts', 'package.json', 'sdk.gen.ts', 'tsconfig.json', 'types.gen.ts'];

describe.each(['petstore', 'edge-cases'])('snapshot: %s', (spec) => {
  it('matches the TypeScript output snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), `archon-snapshot-${spec}-`));
    try {
      const diagnostics: Diagnostic[] = [];
      const out = join(dir, 'out');
      const result = await generate(
        { input: join(specs, `${spec}.yaml`), output: out, plugins: [typescript({ output: '.' })] },
        { cwd: dir, logger: (d) => diagnostics.push(d) },
      );
      expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);

      const files = (result.jobs[0]?.files ?? [])
        .map((f) => relative(out, f).split('\\').join('/'))
        .filter((f) => !f.startsWith('core/'))
        .sort();
      expect(files).toEqual(EXPECTED_FILES);

      for (const file of files) {
        const content = await readFile(join(out, file), 'utf8');
        await expect(content).toMatchFileSnapshot(`__snapshots__/${spec}/${file}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(['petstore', 'edge-cases'])('snapshot (csharp): %s', (spec) => {
  it('matches the C# output snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), `archon-snapshot-cs-${spec}-`));
    try {
      const diagnostics: Diagnostic[] = [];
      const out = join(dir, 'out');
      const result = await generate(
        { input: join(specs, `${spec}.yaml`), output: out, plugins: [csharp({ output: '.' })] },
        { cwd: dir, logger: (d) => diagnostics.push(d) },
      );
      expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);

      // Core/ is the runtime copy, covered by plugins/csharp/client.test.ts.
      const files = (result.jobs[0]?.files ?? [])
        .map((f) => relative(out, f).split('\\').join('/'))
        .filter((f) => !f.startsWith('Core/'))
        .sort();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(join(out, file), 'utf8');
        await expect(content).toMatchFileSnapshot(`__snapshots__/csharp/${spec}/${file}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(['petstore', 'edge-cases'])('snapshot (kotlin): %s', (spec) => {
  it('matches the Kotlin output snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), `archon-snapshot-kt-${spec}-`));
    try {
      const diagnostics: Diagnostic[] = [];
      const out = join(dir, 'out');
      const result = await generate(
        { input: join(specs, `${spec}.yaml`), output: out, plugins: [kotlin({ output: '.' })] },
        { cwd: dir, logger: (d) => diagnostics.push(d) },
      );
      expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);

      // core/ is the runtime copy, covered by plugins/kotlin/client.test.ts.
      const files = (result.jobs[0]?.files ?? [])
        .map((f) => relative(out, f).split('\\').join('/'))
        .filter((f) => !/^src\/main\/kotlin\/.+\/core\//.test(f))
        .sort();
      expect(files).toContain('build.gradle.kts');
      expect(files.some((f) => f.endsWith('/ApiClient.kt'))).toBe(true);
      for (const file of files) {
        const content = await readFile(join(out, file), 'utf8');
        await expect(content).toMatchFileSnapshot(`__snapshots__/kotlin/${spec}/${file}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(['petstore', 'edge-cases'])('snapshot (swift): %s', (spec) => {
  it('matches the Swift output snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), `archon-snapshot-swift-${spec}-`));
    try {
      const diagnostics: Diagnostic[] = [];
      const out = join(dir, 'out');
      const result = await generate(
        { input: join(specs, `${spec}.yaml`), output: out, plugins: [swift({ output: '.' })] },
        { cwd: dir, logger: (d) => diagnostics.push(d) },
      );
      expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);

      // Sources/<Module>Core/ is the runtime copy, covered by plugins/swift/client.test.ts.
      const files = (result.jobs[0]?.files ?? [])
        .map((f) => relative(out, f).split('\\').join('/'))
        .filter((f) => !/^Sources\/[^/]+Core\//.test(f))
        .sort();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(join(out, file), 'utf8');
        await expect(content).toMatchFileSnapshot(`__snapshots__/swift/${spec}/${file}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(['petstore', 'edge-cases'])('snapshot (rust): %s', (spec) => {
  it('matches the Rust output snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), `archon-snapshot-rs-${spec}-`));
    try {
      const diagnostics: Diagnostic[] = [];
      const out = join(dir, 'out');
      const result = await generate(
        { input: join(specs, `${spec}.yaml`), output: out, plugins: [rust({ output: '.' })] },
        { cwd: dir, logger: (d) => diagnostics.push(d) },
      );
      expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);

      // src/core/ is the runtime copy, covered by plugins/rust/client.test.ts.
      const files = (result.jobs[0]?.files ?? [])
        .map((f) => relative(out, f).split('\\').join('/'))
        .filter((f) => !f.startsWith('src/core/'))
        .sort();
      expect(files).toContain('Cargo.toml');
      expect(files).toContain('src/client.rs');
      for (const file of files) {
        const content = await readFile(join(out, file), 'utf8');
        await expect(content).toMatchFileSnapshot(`__snapshots__/rust/${spec}/${file}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
