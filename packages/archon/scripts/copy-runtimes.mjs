// build 前に ../../runtimes/<lang>/src を ./runtimes/<lang>/src にコピーする（配布物にランタイムを同梱するため）。
// テスト（*.test.ts、kotlin の src/test）、.csproj、bin/、obj/、build/、.gradle/ は除く（rust のテストと Cargo.toml は src の外にある）。
// 生成時は src/plugins/<lang>/runtime.ts の resolveRuntimeDir がこのコピーを先に探す。
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(pkgRoot, '..', '..', 'runtimes');
const target = join(pkgRoot, 'runtimes');

const skippedDirs = new Set(['bin', 'obj', 'build', '.gradle']);

/** テスト、プロジェクトファイル、ビルド成果物はコピーしない。 */
const keep = (path) => {
  const name = basename(path);
  if (name === 'test' && basename(dirname(path)) === 'src') return false;
  return !name.endsWith('.test.ts') && !name.endsWith('.csproj') && !skippedDirs.has(name);
};

rmSync(target, { recursive: true, force: true });
for (const entry of readdirSync(source, { withFileTypes: true })) {
  const src = join(source, entry.name, 'src');
  if (!entry.isDirectory() || !existsSync(src)) continue;
  cpSync(src, join(target, entry.name, 'src'), { recursive: true, filter: keep });
}
