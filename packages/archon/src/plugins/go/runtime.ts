import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A runtime source file (`name` is the file name in the runtime directory). */
export type RuntimeFile = { name: string; source: string };

/** The `*.go` files of the runtime `src` directory (package core), by name, without tests. */
export function readGoRuntime(srcDir: string): RuntimeFile[] {
  if (!existsSync(srcDir)) return [];
  return readdirSync(srcDir)
    .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go') && statSync(join(srcDir, name)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(srcDir, name), 'utf8') }));
}
