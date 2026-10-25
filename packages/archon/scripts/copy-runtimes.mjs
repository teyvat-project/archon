// build 前に ../../runtimes/<lang>/src を ./runtimes/<lang>/src にコピーする（配布物にランタイムを同梱するため）。
// 生成時は src/plugins/<lang>/runtime.ts の resolveRuntimeDir がこのコピーを先に探す。
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(pkgRoot, '..', '..', 'runtimes');
const target = join(pkgRoot, 'runtimes');

rmSync(target, { recursive: true, force: true });
for (const entry of readdirSync(source, { withFileTypes: true })) {
  const src = join(source, entry.name, 'src');
  if (!entry.isDirectory() || !existsSync(src)) continue;
  cpSync(src, join(target, entry.name, 'src'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') });
}
