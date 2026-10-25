import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { packageCode } from './names.js';

/** A runtime source file (`name` is the file name in the runtime package directory). */
export type RuntimeFile = { name: string; source: string };

/** The `*.kt` files of `src/main/kotlin/archon/runtime` under the runtime `src` directory, by name (tests are elsewhere). */
export function readKtRuntime(srcDir: string): RuntimeFile[] {
  const dir = join(srcDir, 'main', 'kotlin', 'archon', 'runtime');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.kt') && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

/** Moves the runtime from `archon.runtime` into `<packageName>.core`. */
export function rewritePackage(source: string, packageName: string): string {
  return source.replace(/\barchon\.runtime\b/g, `${packageCode(packageName)}.core`);
}

// Top-level declarations only (they start at column 0): nested types such as `ApiFile.Serializer` cannot be imported by name.
const TYPE_DECLARATION =
  /^(?:public|internal)\s+(?:(?:sealed|abstract|open|data|enum|fun|value|inline|annotation)\s+)*(?:class|interface|object|typealias)\s+([A-Za-z_]\w*)/gm;

/** Top-level type names the runtime declares; generated types avoid them so importing a runtime type never hides a model. */
export function runtimeTypeNames(files: RuntimeFile[]): Set<string> {
  const names = new Set<string>();
  for (const { source } of files) {
    for (const m of source.matchAll(TYPE_DECLARATION)) names.add(m[1] as string);
  }
  return names;
}
