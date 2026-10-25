import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRsRuntime, vendorRuntimeFile } from '../../../src/plugins/rust/runtime.js';

describe('rust plugin: runtime', () => {
  it('reads the .rs files of src only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-rs-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'b.rs'), '');
      writeFileSync(join(dir, 'lib.rs'), '');
      writeFileSync(join(dir, 'notes.md'), '');
      writeFileSync(join(dir, 'nested/c.rs'), '');
      expect(readRsRuntime(dir).map((f) => f.name)).toEqual(['b.rs', 'lib.rs']);
      expect(readRsRuntime(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns lib.rs into mod.rs and moves crate paths under core', () => {
    expect(vendorRuntimeFile({ name: 'lib.rs', source: 'pub use crate::a::B;\npub(crate) fn f() { crate::a::g(); }\n' })).toEqual({
      name: 'mod.rs',
      source: 'pub use crate::core::a::B;\npub(crate) fn f() { crate::core::a::g(); }\n',
    });
    expect(vendorRuntimeFile({ name: 'a.rs', source: 'use crate::b;' }).name).toBe('a.rs');
  });
});
