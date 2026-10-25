import { resolveConfig } from '../../../src/config/resolve.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import type { IRDocument } from '../../../src/ir/types.js';
import { runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { kotlin } from '../../../src/plugins.js';
import type { KotlinPluginAPI, KotlinPluginOptions } from '../../../src/plugins/kotlin/index.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';

export { arr, bin, date, dateTime, int, json, obj, operation, param, prop, ref, response, str } from '../typescript/helpers.js';
export { bool, doc, enumOf, file, nullable, num, squash, union } from '../csharp/helpers.js';

export function options(opts: DeepPartial<KotlinPluginOptions> = {}): KotlinPluginOptions {
  return kotlin(opts).options;
}

export function fakeCtx(ir: IRDocument, opts: KotlinPluginOptions, emitted: EmittedFile[] = []): PluginContext<KotlinPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'kotlin',
    diagnostics: new Diagnostics(),
    emit: (path, content) => void emitted.push({ path, content }),
    headerLines: () => ['Generated header'],
    writer: (o) => new CodeWriter(o),
    plugin: () => {
      throw new Error('no dependencies');
    },
  };
}

/** Runs the plugin (with the hoisting it requests) and returns the emitted files by path. */
export async function generate(ir: IRDocument, opts: DeepPartial<KotlinPluginOptions> = {}) {
  const plugin = kotlin({ packageName: 'test.api', ...opts } as DeepPartial<KotlinPluginOptions>);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const ctx = fakeCtx(pluginIR, plugin.options, emitted);
  const api = (await plugin.definition.generate(ctx)) as KotlinPluginAPI;
  const files = new Map(emitted.map((f) => [f.path, String(f.content)]));
  return { api, emitted, files, diagnostics: ctx.diagnostics, ir: pluginIR };
}

/** Root of the generated sources for package `test.api`. */
export const SRC = 'src/main/kotlin/test/api';

export function model(files: Map<string, string>, name: string): string {
  const path = `${SRC}/models/${name}.kt`;
  const content = files.get(path);
  if (content === undefined) throw new Error(`"${path}" was not emitted (got: ${[...files.keys()].join(', ')})`);
  return content;
}
