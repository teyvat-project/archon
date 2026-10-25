import { resolveConfig } from '../../../src/config/resolve.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../../../src/ir/types.js';
import { runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { csharp } from '../../../src/plugins.js';
import type { CSharpPluginAPI, CSharpPluginOptions } from '../../../src/plugins/csharp/index.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';

export { arr, bin, date, dateTime, int, json, obj, operation, param, prop, ref, response, str } from '../typescript/helpers.js';

export const num: IRSchema = { kind: 'number', nullable: false };
export const bool: IRSchema = { kind: 'boolean', nullable: false };

export const enumOf = (values: (string | number)[], base: 'string' | 'integer' | 'number' = 'string', extra: Partial<IRSchema> = {}): IRSchema =>
  ({ kind: 'enum', nullable: false, base, values, ...extra }) as IRSchema;

export const union = (variants: IRSchema[], discriminator?: { property: string; mapping: Record<string, string> }): IRSchema =>
  ({
    kind: 'union',
    nullable: false,
    variants,
    ...(discriminator && { discriminator: { property: discriminator.property, mapping: new Map(Object.entries(discriminator.mapping)) } }),
  }) as IRSchema;

export const nullable = (schema: IRSchema): IRSchema => ({ ...schema, nullable: true });

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

export function options(opts: DeepPartial<CSharpPluginOptions> = {}): CSharpPluginOptions {
  return csharp(opts).options;
}

export function fakeCtx(ir: IRDocument, opts: CSharpPluginOptions, emitted: EmittedFile[] = []): PluginContext<CSharpPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'csharp',
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
export async function generate(ir: IRDocument, opts: DeepPartial<CSharpPluginOptions> = {}) {
  const plugin = csharp(opts);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const ctx = fakeCtx(pluginIR, plugin.options, emitted);
  const api = (await plugin.definition.generate(ctx)) as CSharpPluginAPI;
  const files = new Map(emitted.map((f) => [f.path, String(f.content)]));
  return { api, emitted, files, diagnostics: ctx.diagnostics, ir: pluginIR };
}

export function file(files: Map<string, string>, path: string): string {
  const content = files.get(path);
  if (content === undefined) throw new Error(`"${path}" was not emitted (got: ${[...files.keys()].join(', ')})`);
  return content;
}

/** Collapses runs of whitespace so multi-line expectations ignore indentation. */
export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export const G = 'global::System';
export const GEN = `${G}.Collections.Generic`;
export const STJ = `${G}.Text.Json`;
export const SER = `${STJ}.Serialization`;
