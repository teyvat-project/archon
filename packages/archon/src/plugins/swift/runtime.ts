import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A runtime source file (`name` is relative to the runtime src directory). */
export type RuntimeFile = { name: string; source: string };

/** The `*.swift` files directly in `dir`, by name. */
export function readSwiftRuntime(dir: string): RuntimeFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.swift') && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

const PUBLIC_DECLARATION = /^\s*public\s+(?:final\s+)?(?:struct|class|enum|protocol|actor|typealias)\s+([A-Za-z_]\w*)/gm;

/**
 * Top-level public type names of the runtime. Generated types avoid them: the runtime module is re-exported, so a
 * model of the same name would be ambiguous for SDK users.
 */
export function runtimeTypeNames(files: RuntimeFile[]): Set<string> {
  const names = new Set<string>();
  for (const { source } of files) {
    for (const m of source.matchAll(PUBLIC_DECLARATION)) names.add(m[1] as string);
  }
  return names;
}
