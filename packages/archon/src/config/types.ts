import type { InputConfig } from '../loader/load.js';
import type { PatchConfig } from '../loader/patch.js';
import type { ParserHooks } from '../parser/index.js';
import type { FiltersConfig } from '../passes/filters.js';
import type { HoistOptions } from '../passes/hoist.js';
import type { TransformsConfig } from '../passes/index.js';
import type { ArchonPlugin } from '../plugin/types.js';

export type HeaderContext = { defaultValue: string[]; language: string };

export type PostProcessCommand = { command: string; args: string[] };

export type OutputConfig = {
  path: string;
  clean?: boolean;
  header?: (ctx: HeaderContext) => string[];
  postProcess?: PostProcessCommand[];
};

export type UserConfig = {
  input: InputConfig;
  output: string | OutputConfig;
  parser?: {
    filters?: FiltersConfig;
    patch?: PatchConfig;
    transforms?: TransformsConfig;
    hooks?: ParserHooks & { inlineSchemaName?: HoistOptions['nameHook'] };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins?: ArchonPlugin<any, any>[];
};

export type ResolvedConfig = Required<Pick<UserConfig, 'input' | 'plugins'>> & {
  output: Required<OutputConfig>;
  parser: NonNullable<UserConfig['parser']>;
  root: string;
};

export function defineConfig(config: UserConfig): UserConfig;
export function defineConfig(config: UserConfig[]): UserConfig[];
export function defineConfig(config: UserConfig | UserConfig[]): UserConfig | UserConfig[];
export function defineConfig(config: UserConfig | UserConfig[]): UserConfig | UserConfig[] {
  return config;
}
