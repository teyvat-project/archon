import { isAbsolute, resolve } from 'node:path';
import type { Diagnostics } from '../diagnostics.js';
import type { InputConfig } from '../loader/load.js';
import type { OutputConfig, ResolvedConfig, UserConfig } from './types.js';

const URL_PATTERN = /^https?:\/\//i;

/**
 * 既定値を埋め、相対パスを解決する。`opts.cwd` が基準 (`root`) になる。
 * 設定ファイルを読み込んだ場合は、呼び出し側がそのファイルのディレクトリを `cwd` として渡すこと。
 */
export function resolveConfig(config: UserConfig, opts: { cwd: string }, diagnostics?: Diagnostics): ResolvedConfig {
  const root = opts.cwd;
  const output: OutputConfig = typeof config.output === 'string' ? { path: config.output } : config.output;
  const plugins = config.plugins ?? [];
  if (plugins.length === 0) {
    diagnostics?.warn('no-plugins', 'No plugins configured; nothing will be generated.');
  }
  return {
    input: resolveInput(config.input, root),
    plugins,
    parser: config.parser ?? {},
    output: {
      path: resolve(root, output.path),
      clean: output.clean ?? true,
      header: output.header ?? ((ctx) => ctx.defaultValue),
      postProcess: output.postProcess ?? [],
    },
    root,
  };
}

function resolveInput(input: InputConfig, root: string): InputConfig {
  if (typeof input === 'string') return resolvePath(input, root);
  if (typeof input['path'] === 'string' && !('openapi' in input) && !('swagger' in input)) {
    return { ...input, path: resolvePath(input['path'], root) } as InputConfig;
  }
  return input;
}

function resolvePath(p: string, root: string): string {
  return URL_PATTERN.test(p) || isAbsolute(p) ? p : resolve(root, p);
}
