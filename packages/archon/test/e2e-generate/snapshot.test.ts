import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/diagnostics.js';
import { generate } from '../../src/generate.js';
import { typescript } from '../../src/plugins.js';

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
