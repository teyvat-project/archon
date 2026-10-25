import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A runtime source file (`name` is relative to the runtime src directory). */
export type RuntimeFile = { name: string; source: string };

/** The `*.cs` files directly in `dir` (bin/ and obj/ are directories and skipped), by name. */
export function readCsRuntime(dir: string): RuntimeFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.cs') && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

/** Moves the runtime from `Archon.Runtime` into `<namespace>.Core`. */
export function rewriteNamespace(source: string, namespace: string): string {
  return source.replace(/\bArchon\.Runtime\b/g, `${namespace}.Core`);
}

const TYPE_DECLARATION =
  /\b(?:public|internal)\s+(?:(?:sealed|static|abstract|partial|readonly|ref)\s+)*(?:class|struct|record(?:\s+struct|\s+class)?|enum|interface)\s+([A-Za-z_]\w*)/g;
const DELEGATE_DECLARATION = /\bdelegate\s+[^;(]+?\s+([A-Za-z_]\w*)\s*\(/g;

/** Type names the runtime declares; generated types avoid them so `using <namespace>.Core;` never shadows. */
export function runtimeTypeNames(files: RuntimeFile[]): Set<string> {
  const names = new Set<string>();
  for (const { source } of files) {
    for (const m of source.matchAll(TYPE_DECLARATION)) names.add(m[1] as string);
    for (const m of source.matchAll(DELEGATE_DECLARATION)) names.add(m[1] as string);
  }
  return names;
}
