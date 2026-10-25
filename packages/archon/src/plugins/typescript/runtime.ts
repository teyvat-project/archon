import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArchonError } from '../../diagnostics.js';

/** ランタイムのソースファイル（`name` はランタイム src ディレクトリ相対のファイル名）。 */
export type RuntimeFile = { name: string; source: string };

/**
 * 手書きランタイムのソースディレクトリを返す。`fromUrl`（既定はこのモジュール）に最も近い `package.json` の
 * ディレクトリをパッケージルートとする。
 * - `<pkgRoot>/src` 配下から読み込まれた（リポジトリでの開発時）: `<pkgRoot>/../../runtimes/<language>/src` →
 *   `<pkgRoot>/runtimes/<language>/src`（build 時のコピーは古い可能性があるので後回し）
 * - それ以外（`dist/` の配布物）: `<pkgRoot>/runtimes/<language>/src` のみ（インストール先では `<pkgRoot>/../..` が
 *   無関係なディレクトリになり得るので見ない）
 */
export function resolveRuntimeDir(language: string, fromUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(fromUrl);
  const pkgRoot = findPackageRoot(dirname(modulePath));
  const candidates: string[] = [];
  if (pkgRoot !== undefined) {
    const packaged = join(pkgRoot, 'runtimes', language, 'src');
    const rel = relative(join(pkgRoot, 'src'), modulePath);
    const fromSource = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (fromSource) candidates.push(join(pkgRoot, '..', '..', 'runtimes', language, 'src'));
    candidates.push(packaged);
  }
  const found = candidates.find((dir) => existsSync(join(dir, 'index.ts')));
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

/** `dir` 直下の `*.ts`（`*.test.ts` / `*.d.ts` を除く）を名前順に読む。 */
export function readRuntime(dir: string): RuntimeFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

const RELATIVE_JS_SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*?)\.js\2/g;

/** 相対 import / export の `.js` 拡張子を `ext` に書き換える。 */
export function rewriteImportExtensions(source: string, ext: '.js' | '.ts' | ''): string {
  if (ext === '.js') return source;
  return source.replace(RELATIVE_JS_SPECIFIER, (_m, lead: string, q: string, spec: string) => `${lead}${q}${spec}${ext}${q}`);
}

const EXPORT_DECLARATION =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/**
 * ランタイムが（どのファイルからでも）export する名前。生成コードの名前と衝突させないために使う。
 * index.ts が再 export しない名前も含むが、余分に避ける分には害がない。
 */
export function runtimeExportNames(files: RuntimeFile[]): Set<string> {
  const names = new Set<string>();
  for (const { source } of files) {
    for (const m of source.matchAll(EXPORT_DECLARATION)) names.add(m[1] as string);
    for (const m of source.matchAll(EXPORT_LIST)) {
      for (const entry of (m[1] as string).split(',')) {
        const parts = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0] ?? '').trim();
        if (name !== '') names.add(name);
      }
    }
  }
  return names;
}
