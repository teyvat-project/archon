import { resolveConfig } from '../../../src/config/resolve.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../../../src/ir/types.js';
import { runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { swift } from '../../../src/plugins.js';
import type { SwiftPluginAPI, SwiftPluginOptions } from '../../../src/plugins/swift/index.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';

export { arr, bin, date, dateTime, int, json, obj, operation, param, prop, ref, response, str } from '../typescript/helpers.js';
export { bool, enumOf, nullable, num, squash, union } from '../csharp/helpers.js';

export function doc(schemas: Record<string, IRSchema>, operations: IROperation[] = [], extra: Partial<IRDocument> = {}): IRDocument {
  return {
    info: { title: 'Test API', version: '1.2.3' },
    servers: [{ url: 'https://api.test/v1', variables: {} }],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations,
    ...extra,
  };
}

export function options(opts: DeepPartial<SwiftPluginOptions> = {}): SwiftPluginOptions {
  return swift(opts).options;
}

export function fakeCtx(ir: IRDocument, opts: SwiftPluginOptions, emitted: EmittedFile[] = []): PluginContext<SwiftPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'swift',
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
export async function generate(ir: IRDocument, opts: DeepPartial<SwiftPluginOptions> = {}) {
  const plugin = swift(opts);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const ctx = fakeCtx(pluginIR, plugin.options, emitted);
  const api = (await plugin.definition.generate(ctx)) as SwiftPluginAPI;
  const files = new Map(emitted.map((f) => [f.path, String(f.content)]));
  return { api, emitted, files, diagnostics: ctx.diagnostics, ir: pluginIR };
}

/** The content of `Sources/TestApi/<path>` (the default module of `doc()`). */
export function source(files: Map<string, string>, path: string, module = 'TestApi'): string {
  return file(files, `Sources/${module}/${path}`);
}

export function file(files: Map<string, string>, path: string): string {
  const content = files.get(path);
  if (content === undefined) throw new Error(`"${path}" was not emitted (got: ${[...files.keys()].join(', ')})`);
  return content;
}
