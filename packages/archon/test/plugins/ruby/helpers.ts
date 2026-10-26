import { resolveConfig } from '../../../src/config/resolve.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import type { IRDocument } from '../../../src/ir/types.js';
import { runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { ruby } from '../../../src/plugins.js';
import type { RubyPluginAPI, RubyPluginOptions } from '../../../src/plugins/ruby/index.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';

export { arr, bin, date, dateTime, int, json, obj, operation, param, prop, ref, response, str } from '../typescript/helpers.js';
export { bool, doc, enumOf, file, nullable, num, squash, union } from '../csharp/helpers.js';

export function options(opts: DeepPartial<RubyPluginOptions> = {}): RubyPluginOptions {
  return ruby(opts).options;
}

export function fakeCtx(ir: IRDocument, opts: RubyPluginOptions, emitted: EmittedFile[] = []): PluginContext<RubyPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'ruby',
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
export async function generate(ir: IRDocument, opts: DeepPartial<RubyPluginOptions> = {}) {
  const plugin = ruby({ gemName: 'api', ...opts } as DeepPartial<RubyPluginOptions>);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const ctx = fakeCtx(pluginIR, plugin.options, emitted);
  const api = (await plugin.definition.generate(ctx)) as RubyPluginAPI;
  const files = new Map(emitted.map((f) => [f.path, String(f.content)]));
  return { api, emitted, files, diagnostics: ctx.diagnostics, ir: pluginIR };
}

export function model(files: Map<string, string>, snake: string, gem = 'api'): string {
  const path = `lib/${gem}/models/${snake}.rb`;
  const content = files.get(path);
  if (content === undefined) throw new Error(`"${path}" was not emitted (got: ${[...files.keys()].join(', ')})`);
  return content;
}
