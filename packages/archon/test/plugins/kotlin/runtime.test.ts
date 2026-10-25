import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readKtRuntime, rewritePackage, runtimeTypeNames } from '../../../src/plugins/kotlin/runtime.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/kotlin/src', import.meta.url));

describe('kotlin plugin: runtime', () => {
  it('reads runtime files and rewrites the package', () => {
    const files = readKtRuntime(repoRuntime);
    const expected = readdirSync(join(repoRuntime, 'main/kotlin/archon/runtime')).filter((f) => f.endsWith('.kt')).sort();
    expect(files.map((f) => f.name)).toEqual(expected);
    const source = 'package archon.runtime\n\nimport archon.runtime.extra.X\nval y = archon.runtime.ApiJson\n';
    expect(rewritePackage(source, 'com.example')).toBe('package com.example.core\n\nimport com.example.core.extra.X\nval y = com.example.core.ApiJson\n');
  });

  it('escapes keyword segments of the package', () => {
    expect(rewritePackage('package archon.runtime\n', 'my.in.sdk')).toBe('package my.`in`.sdk.core\n');
  });

  it('runtimeTypeNames lists public and internal runtime types', () => {
    const names = runtimeTypeNames(readKtRuntime(repoRuntime));
    for (const name of ['ApiClientCore', 'ApiRequest', 'ApiException', 'Middleware', 'CallContext', 'SecuritySchemeSpec', 'ParamStyle', 'TokenSet', 'ApiFile', 'AuthMiddleware', 'ApiUrl', 'RetryMiddleware']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('skips test sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-kt-'));
    try {
      mkdirSync(join(dir, 'main/kotlin/archon/runtime'), { recursive: true });
      mkdirSync(join(dir, 'test/kotlin/archon/runtime'), { recursive: true });
      writeFileSync(join(dir, 'main/kotlin/archon/runtime/B.kt'), 'package archon.runtime');
      writeFileSync(join(dir, 'main/kotlin/archon/runtime/A.kt'), 'package archon.runtime');
      writeFileSync(join(dir, 'test/kotlin/archon/runtime/ATest.kt'), 'package archon.runtime');
      expect(readKtRuntime(dir).map((f) => f.name)).toEqual(['A.kt', 'B.kt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
