import { resolve } from 'node:path';
import { resolveConfig } from './config/resolve.js';
import type { UserConfig } from './config/types.js';
import { Diagnostics } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { loadInput } from './loader/load.js';
import { applyPatch } from './loader/patch.js';
import { parseDocument } from './parser/index.js';
import { runCommonPasses } from './passes/index.js';
import { runPlugins } from './plugin/host.js';
import { writeOutput } from './writer/output.js';

export type GenerateOptions = {
  /** 相対パスの基準 (resolveConfig の root)。既定は process.cwd()。 */
  cwd?: string;
  /** warn が 1 件でもあれば、書き出す前に `strict-warnings` で失敗する。 */
  strict?: boolean;
  verbose?: boolean;
  /** 指定した名前のプラグイン（と推移的な依存）だけを実行する。 */
  plugins?: string[];
  logger?: (d: Diagnostic) => void;
};

export type GenerateResult = {
  jobs: { files: string[]; diagnostics: Diagnostic[] }[];
};

/** 設定ごとのジョブを順に実行する。 */
export async function generate(config: UserConfig | UserConfig[], opts: GenerateOptions = {}): Promise<GenerateResult> {
  const configs = Array.isArray(config) ? config : [config];
  const jobs: GenerateResult['jobs'] = [];
  for (const userConfig of configs) jobs.push(await runJob(userConfig, opts));
  return { jobs };
}

async function runJob(userConfig: UserConfig, opts: GenerateOptions): Promise<GenerateResult['jobs'][number]> {
  const cwd = opts.cwd ?? process.cwd();
  const diagnostics = new Diagnostics({
    ...(opts.verbose !== undefined && { verbose: opts.verbose }),
    ...(opts.logger !== undefined && { sink: opts.logger }),
  });

  const config = resolveConfig(userConfig, { cwd }, diagnostics);
  const { inlineSchemaName, ...parserHooks } = config.parser.hooks ?? {};

  const doc = await loadInput(config.input, { cwd, diagnostics });
  applyPatch(doc, config.parser.patch, diagnostics);
  const ir = parseDocument(doc, { diagnostics, hooks: parserHooks });
  runCommonPasses(
    ir,
    {
      ...(config.parser.filters !== undefined && { filters: config.parser.filters }),
      ...(config.parser.transforms !== undefined && { transforms: config.parser.transforms }),
      ...(inlineSchemaName !== undefined && { inlineSchemaName }),
    },
    diagnostics,
  );

  const { files, outputDirs } = await runPlugins(ir, config, diagnostics, {
    ...(opts.plugins !== undefined && { only: opts.plugins }),
  });

  if (opts.strict && diagnostics.hasWarnings()) {
    const count = diagnostics.entries.filter((e) => e.level === 'warn').length;
    diagnostics.error('strict-warnings', `${count} warning(s) were reported and --strict is enabled; nothing was written.`);
  }

  await writeOutput(files, config.output, { root: config.root, diagnostics, outputDirs });

  return {
    files: files.map((f) => resolve(config.output.path, f.path)),
    diagnostics: diagnostics.entries,
  };
}
