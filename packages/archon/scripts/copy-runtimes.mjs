// build 前に ../../runtimes/<lang>/src を ./runtimes/<lang>/src にコピーする（配布物にランタイムを同梱するため）。
// テスト（*.test.ts）、.csproj、bin/、obj/ は除く。
// 生成時は src/plugins/<lang>/runtime.ts の resolveRuntimeDir がこのコピーを先に探す。
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(pkgRoot, '..', '..', 'runtimes');
const target = join(pkgRoot, 'runtimes');

/** テスト、プロジェクトファイル、ビルド成果物はコピーしない。 */
const keep = (path) => {
  const name = basename(path);
  return !name.endsWith('.test.ts') && !name.endsWith('.csproj') && name !== 'bin' && name !== 'obj';
};

rmSync(target, { recursive: true, force: true });
for (const entry of readdirSync(source, { withFileTypes: true })) {
  const src = join(source, entry.name, 'src');
  if (!entry.isDirectory() || !existsSync(src)) continue;
  cpSync(src, join(target, entry.name, 'src'), { recursive: true, filter: keep });
}
