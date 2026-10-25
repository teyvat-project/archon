import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArchonError } from '../diagnostics.js';

/**
 * 手書きランタイムのソースディレクトリを返す。`fromUrl`（既定はこのモジュール）に最も近い `package.json` の
 * ディレクトリをパッケージルートとし、`marker`（既定 `index.ts`）があるディレクトリを採用する。
 * - `<pkgRoot>/src` 配下から読み込まれた（リポジトリでの開発時）: `<pkgRoot>/../../runtimes/<language>/src` →
 *   `<pkgRoot>/runtimes/<language>/src`（build 時のコピーは古い可能性があるので後回し）
 * - それ以外（`dist/` の配布物）: `<pkgRoot>/runtimes/<language>/src` のみ（インストール先では `<pkgRoot>/../..` が
 *   無関係なディレクトリになり得るので見ない）
 */
export function resolveRuntimeDir(language: string, opts: { marker?: string; fromUrl?: string } = {}): string {
  const marker = opts.marker ?? 'index.ts';
  const modulePath = fileURLToPath(opts.fromUrl ?? import.meta.url);
  const pkgRoot = findPackageRoot(dirname(modulePath));
  const candidates: string[] = [];
  if (pkgRoot !== undefined) {
    const packaged = join(pkgRoot, 'runtimes', language, 'src');
    const rel = relative(join(pkgRoot, 'src'), modulePath);
    const fromSource = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (fromSource) candidates.push(join(pkgRoot, '..', '..', 'runtimes', language, 'src'));
    candidates.push(packaged);
  }
  const found = candidates.find((dir) => existsSync(join(dir, marker)));
  if (found === undefined) {
    throw new ArchonError(
      'runtime-missing',
      `The ${language} runtime was not found (looked in: ${candidates.join(', ') || 'no package root'}).`,
    );
  }
  return found;
}

function findPackageRoot(start: string): string | undefined {
  for (let dir = start; ; ) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

