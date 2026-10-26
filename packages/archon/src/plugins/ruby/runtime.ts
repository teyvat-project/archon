import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A runtime file: `name` is its path relative to the runtime `src` directory (`core.rb`, `core/client.rb`, `core.rbs`). */
export type RuntimeFile = { name: string; source: string };

/** The runtime loader, its `core/*.rb` files and `core.rbs`, by name (tests live outside `src`). */
export function readRubyRuntime(srcDir: string): RuntimeFile[] {
  if (!existsSync(srcDir)) return [];
  const read = (name: string) => ({ name, source: readFileSync(join(srcDir, name), 'utf8') });
  const top = ['core.rb', 'core.rbs'].filter((name) => existsSync(join(srcDir, name)));
  const coreDir = join(srcDir, 'core');
  const nested = existsSync(coreDir)
    ? readdirSync(coreDir)
        .filter((name) => name.endsWith('.rb') && statSync(join(coreDir, name)).isFile())
        .sort()
        .map((name) => `core/${name}`)
    : [];
  return [...top, ...nested].map(read);
}

/** The runtime source with its namespace `Archon::Core` replaced by `<moduleName>::Core`. */
export function rebrand(source: string, moduleName: string): string {
  return source.replace(/\bArchon::Core\b/g, `${moduleName}::Core`);
}

/** Inserts the generated header after the leading `# frozen_string_literal: true` line (or at the top of an RBS file). */
export function withHeader(source: string, header: string[]): string {
  const magic = '# frozen_string_literal: true\n';
  if (source.startsWith(magic)) return `${magic}\n${header.join('\n')}\n${source.slice(magic.length)}`;
  return `${header.join('\n')}\n\n${source}`;
}
