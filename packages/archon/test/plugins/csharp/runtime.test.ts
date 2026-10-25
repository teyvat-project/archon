import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCsRuntime, rewriteNamespace, runtimeTypeNames } from '../../../src/plugins/csharp/runtime.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/csharp/src', import.meta.url));

describe('csharp plugin: runtime', () => {
  it('reads the runtime sources, excluding bin and obj', () => {
    const files = readCsRuntime(repoRuntime);
    expect(files.map((f) => f.name)).toEqual(readdirSync(repoRuntime).filter((f) => f.endsWith('.cs')).sort());
    expect(files.some((f) => f.name.includes('/'))).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'archon-cs-'));
    try {
      writeFileSync(join(dir, 'A.cs'), 'namespace Archon.Runtime;');
      for (const sub of ['bin', 'obj']) {
        mkdirSync(join(dir, sub));
        writeFileSync(join(dir, sub, 'B.cs'), '');
      }
      expect(readCsRuntime(dir).map((f) => f.name)).toEqual(['A.cs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites the namespace', () => {
    const source = 'using Archon.Runtime.Extra;\nnamespace Archon.Runtime;\nclass X { Archon.Runtime.Y y; }\n';
    expect(rewriteNamespace(source, 'My.Sdk')).toBe('using My.Sdk.Core.Extra;\nnamespace My.Sdk.Core;\nclass X { My.Sdk.Core.Y y; }\n');
  });

  it('runtimeTypeNames lists public runtime types', () => {
    const names = runtimeTypeNames(readCsRuntime(repoRuntime));
    for (const name of ['ApiClientCore', 'ApiRequest', 'ApiException', 'ApiNext', 'IApiMiddleware', 'SecuritySchemeSpec', 'ParamStyle', 'TokenSet', 'ApiFile']) {
      expect(names.has(name)).toBe(true);
    }
  });
});
