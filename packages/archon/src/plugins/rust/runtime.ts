import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A runtime source file (`name` is the file name in the runtime's `src` directory). */
export type RuntimeFile = { name: string; source: string };

/** The `*.rs` files of the runtime's `src` directory, by name (the crate's tests live in `tests/`, outside it). */
export function readRsRuntime(srcDir: string): RuntimeFile[] {
  if (!existsSync(srcDir)) return [];
  return readdirSync(srcDir)
    .filter((name) => name.endsWith('.rs') && statSync(join(srcDir, name)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(srcDir, name), 'utf8') }));
}

/** Moves a runtime file under `crate::core`: `lib.rs` becomes `mod.rs` and `crate::` paths gain `core::`. */
export function vendorRuntimeFile(file: RuntimeFile): RuntimeFile {
  return {
    name: file.name === 'lib.rs' ? 'mod.rs' : file.name,
    source: file.source.replace(/\bcrate::/g, 'crate::core::'),
  };
}
