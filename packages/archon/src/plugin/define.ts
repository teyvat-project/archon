import type { ArchonPlugin, PluginDefinition } from './types.js';

/** 関数・配列は丸ごと置換、object のみ再帰的に部分指定できる。 */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/**
 * プラグインを定義し、ユーザー向けのファクトリ関数を返す。
 * ファクトリに渡した options は `defaults` に deep merge される
 * （plain object は再帰的にマージ、配列・関数・クラスインスタンス・プリミティブは置換、`undefined` は無視）。
 */
export function definePlugin<O, API = void>(
  def: PluginDefinition<O, API>,
): (options?: DeepPartial<O>) => ArchonPlugin<O, API> {
  return (options) => ({
    name: def.name,
    options: deepMerge(def.defaults, options) as O,
    definition: def,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return isPlainObject(base) ? deepMerge(base, {}) : base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) out[key] = deepMerge(base[key], override[key]);
  for (const key of Object.keys(override)) {
    if (!(key in base) && override[key] !== undefined) out[key] = override[key];
  }
  return out;
}
