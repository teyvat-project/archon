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
  const path = findConfigFile(opts);

  let loaded: unknown;
  try {
    if (path.endsWith('.json')) {
      loaded = JSON.parse(readFileSync(path, 'utf8'));
    } else {
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      loaded = await jiti.import(path, { default: true });
    }
  } catch (e) {
    throw new ArchonError('config-invalid', `Failed to load config file ${path}: ${String(e)}`);
  }

  const configs = Array.isArray(loaded) ? loaded : [loaded];
  configs.forEach((config: unknown, i) => {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new ArchonError('config-invalid', `Config file ${path} must export a config object (or an array of them)${where(i, loaded)}`);
    }
    const missing = (['input', 'output'] as const).filter((key) => (config as Record<string, unknown>)[key] === undefined);
    if (missing.length > 0) {
      throw new ArchonError('config-invalid', `Config file ${path} is missing ${missing.map((k) => `"${k}"`).join(' and ')}${where(i, loaded)}`);
    }
  });
  return configs as UserConfig[];
}

function where(index: number, loaded: unknown): string {
  return Array.isArray(loaded) ? ` (entry ${index})` : '';
}

/**
 * 読み込む設定ファイルの絶対パスを返す。`file` 省略時は cwd で archon.config.{ts,mts,mjs,js,json} を順に探す。
 * 見つからなければ `config-not-found` の ArchonError。
 */
export function findConfigFile(opts: { cwd: string; file?: string }): string {
  if (opts.file !== undefined) {
    const path = resolve(opts.cwd, opts.file);
    if (!existsSync(path)) throw new ArchonError('config-not-found', `Config file not found: ${path}`);
    return path;
  }
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(opts.cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new ArchonError(
    'config-not-found',
    `No config file found in ${opts.cwd} (looked for ${CONFIG_NAMES.join(', ')})`,
  );
}
