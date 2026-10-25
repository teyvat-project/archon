import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import { ArchonError } from '../diagnostics.js';
import type { UserConfig } from './types.js';

const CONFIG_NAMES = ['ts', 'mts', 'mjs', 'js', 'json'].map((ext) => `archon.config.${ext}`);

/**
 * 設定ファイルを読み込み、常に配列で返す。`file` 省略時は cwd で archon.config.{ts,mts,mjs,js,json} を順に探す。
 * 呼び出し側は、読み込んだファイルのディレクトリを resolveConfig の `cwd` として渡すこと。
 */
export async function loadConfigFile(opts: { cwd: string; file?: string }): Promise<UserConfig[]> {
  const path = opts.file !== undefined ? resolve(opts.cwd, opts.file) : findConfig(opts.cwd);
  if (path === undefined || !existsSync(path)) {
    const what = opts.file !== undefined ? `Config file not found: ${resolve(opts.cwd, opts.file)}` : `No config file found in ${opts.cwd} (looked for ${CONFIG_NAMES.join(', ')})`;
    throw new ArchonError('config-not-found', what);
  }

  let loaded: unknown;
  if (path.endsWith('.json')) {
    loaded = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    loaded = await jiti.import(path, { default: true });
  }
  return Array.isArray(loaded) ? (loaded as UserConfig[]) : [loaded as UserConfig];
}

function findConfig(cwd: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
