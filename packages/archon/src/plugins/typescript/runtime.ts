import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArchonError } from '../../diagnostics.js';

/** ランタイムのソースファイル（`name` はランタイム src ディレクトリ相対のファイル名）。 */
export type RuntimeFile = { name: string; source: string };

/**
 * 手書きランタイムのソースディレクトリを返す。このモジュールに最も近い `package.json` のディレクトリを
 * パッケージルートとし、`<pkgRoot>/runtimes/<language>/src`（build 時にコピーされた配布物）→
 * `<pkgRoot>/../../runtimes/<language>/src`（リポジトリでの開発時）の順に探す。
 */
export function resolveRuntimeDir(language: string): string {
  const pkgRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const candidates = pkgRoot
    ? [join(pkgRoot, 'runtimes', language, 'src'), join(pkgRoot, '..', '..', 'runtimes', language, 'src')]
    : [];
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
