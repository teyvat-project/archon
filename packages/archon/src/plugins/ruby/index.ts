import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin, type PluginFactory } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NamingRule } from '../csharp/index.js';
import { renderAuth, renderClient, renderEntry } from './client.js';
import { headerComment } from './emit.js';
import { planModels, renderModels } from './models.js';
import { buildNames, resolveGemName, resolveModuleName } from './names.js';
import { renderGemspec, renderVersion } from './project.js';
import { renderRbs } from './rbs.js';
import { readRubyRuntime, rebrand, withHeader } from './runtime.js';
import { buildServiceNames, renderServices, selectOperations } from './services.js';
import { RubyTypeResolver, type RubyTypeMapping } from './types.js';

export interface RubyPluginOptions {
  /** Subdirectory of `output.path`. Default `'ruby'`. */
  output: string;
  /** The gem name (`lib/<gemName>.rb`, `<gemName>.gemspec`). Default: the title in snake_case. */
  gemName: string | undefined;
  /** The SDK module (`'Acme::Api'` nests). Default: the gem name in PascalCase. */
  moduleName: string | undefined;
  /** `.gemspec` settings; `false` emits no gemspec. `version` defaults to the spec's version when RubyGems accepts it. */
  package:
    | false
    | { version?: string; summary?: string; description?: string; authors?: string[]; license?: string; homepage?: string; requiredRubyVersion?: string }
    | undefined;
  /** Defaults: type PascalCase, method / property / file snake_case. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /**
   * Keys `'kind:format'` (e.g. `'string:date-time'`) or `'kind'` (e.g. `'integer'`). The value is a built-in type
   * (`'string'`, `'integer'`, `'number'`, `'boolean'`, `'time'`, `'date'`, `'bytes'`, `'upload'`, `'any'`), or a
   * Core::Types expression with its RBS type (`{ type: 'MyTypes::MONEY', rbs: '::BigDecimal' }`).
   */
  typeMappings: Record<string, RubyTypeMapping>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => RubyTypeMapping | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface RubyPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; constant: string; file: string };
    operation(operationId: string): { service: string; reader: string; method: string; file: string };
  };
}

export const ruby: PluginFactory<RubyPluginOptions, RubyPluginAPI> = definePlugin<RubyPluginOptions, RubyPluginAPI>({
  name: 'ruby',
  defaults: {
    output: 'ruby',
    gemName: undefined,
    moduleName: undefined,
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'snake_case' }, property: { case: 'snake_case' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const runtime = readRubyRuntime(resolveRuntimeDir('ruby', { marker: 'core.rb' }));
    const gemName = resolveGemName(ctx.ir, ctx.options);
    const moduleName = resolveModuleName(gemName, ctx.options);
    const ops = selectOperations(ctx.ir.operations, ctx.options);
    const serviceNames = buildServiceNames(ops);
    const names = buildNames(ctx.ir, ctx.options, [...serviceNames.values()].map((s) => s.className));
    const resolver = new RubyTypeResolver(ctx.ir, names, ctx.options, ctx.diagnostics);
    const plan = planModels(ctx.ir, resolver);
    const lib = `lib/${gemName}`;

    const models = renderModels({ ctx, names, resolver, plan, moduleName });
    for (const model of models) ctx.emit(`${lib}/${model.path}`, model.content);
    const rendered = renderServices(ctx, ops, serviceNames, names, resolver, moduleName);
    for (const service of rendered.files) ctx.emit(`${lib}/${service.path}`, service.content);
    ctx.emit(`${lib}/client.rb`, renderClient(ctx, moduleName, rendered.services));
    ctx.emit(`${lib}/auth.rb`, renderAuth(ctx, moduleName));
    ctx.emit(`${lib}/version.rb`, renderVersion(ctx, moduleName));
    const files = [...models.map((m) => m.path), ...rendered.files.map((f) => f.path), 'auth.rb', 'client.rb'];
    ctx.emit(`lib/${gemName}.rb`, renderEntry(ctx, gemName, moduleName, files));
    for (const file of renderGemspec(ctx, gemName, moduleName)) ctx.emit(file.file, file.content);
    ctx.emit(`sig/${gemName}.rbs`, renderRbs({ ctx, names, resolver, plan }, moduleName, rendered.services));

    const header = headerComment(ctx);
    for (const file of runtime) {
      const path = file.name === 'core.rbs' ? `sig/${gemName}/core.rbs` : `${lib}/${file.name}`;
      ctx.emit(path, withHeader(rebrand(file.source, moduleName), header));
    }

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, constant: `${moduleName}::${name}`, file: `${lib}/${names.files.get(schemaName) as string}` };
        },
        operation(operationId) {
          const op = rendered.operations.get(operationId);
          if (op === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return { service: `${moduleName}::${op.className}`, reader: op.reader, method: op.method, file: `${lib}/${op.file}` };
        },
      },
    };
  },
});
