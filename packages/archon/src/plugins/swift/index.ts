import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin, type PluginFactory } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NameCase } from '../../writer/naming.js';
import { renderAuth, renderClient, renderExports } from './client.js';
import { renderModels, type ModelContext } from './models.js';
import { buildNames, fileBaseName, resolveModuleName } from './names.js';
import { renderPackage } from './package.js';
import { MODULE_NAMES, UNDECLARABLE_TYPES } from './reserved.js';
import { readSwiftRuntime, runtimeTypeNames } from './runtime.js';
import { buildServiceNames, renderServices, selectOperations } from './services.js';
import { boxedProperties, SwTypeResolver } from './types.js';

export type NamingRule = { case?: NameCase; name?: string | ((name: string) => string) };

export interface SwiftPluginOptions {
  /** Subdirectory of `output.path`. Default `'swift'`. */
  output: string;
  /** Name of the SDK module (and library product). Default: the title in PascalCase. The runtime is `<moduleName>Core`. */
  moduleName: string | undefined;
  /** Name of the client class. Default `'ApiClient'`. */
  clientName: string;
  /** `Package.swift` settings; `false` emits no manifest. `name` defaults to the module name. */
  package: false | { name?: string } | undefined;
  /** Defaults: type PascalCase, method camelCase, property camelCase, file = type name. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /**
   * Keys `'kind:format'` (e.g. `'string:uuid'`) or `'kind'` (e.g. `'integer'`); values are Swift type expressions
   * (they must be `Codable`, `Hashable` and `Sendable`).
   */
  typeMappings: Record<string, string>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    /** The returned Swift type is used as-is (`?` is still added for optional / nullable usages). */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => string | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface SwiftPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; module: string; file: string };
    operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string };
  };
}

export const swift: PluginFactory<SwiftPluginOptions, SwiftPluginAPI> = definePlugin<SwiftPluginOptions, SwiftPluginAPI>({
  name: 'swift',
  defaults: {
    output: 'swift',
    moduleName: undefined,
    clientName: 'ApiClient',
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'camelCase' }, property: { case: 'camelCase' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readSwiftRuntime(resolveRuntimeDir('swift', { marker: 'ApiClientCore.swift' }));
    const module = resolveModuleName(ctx.ir, opts);
    const core = `${module}Core`;
    const ops = selectOperations(ctx.ir.operations, opts);
    const services = buildServiceNames(ops);
    const declared = ['ApiAuth', opts.clientName, ...[...services.values()].map((s) => s.typeName)];
    const reserved = [...runtimeTypeNames(runtime), ...MODULE_NAMES, ...UNDECLARABLE_TYPES, module, core, ...declared];
    const names = buildNames(ctx.ir, opts, reserved, declared);
    const resolver = new SwTypeResolver(ctx.ir, names, opts, ctx.diagnostics);
    const dir = `Sources/${module}`;
    const m: ModelContext = { ctx, names, resolver, boxed: boxedProperties(ctx.ir, resolver), imports: ['Foundation', core], dir };

    for (const model of renderModels(m)) ctx.emit(model.path, model.content);
    const rendered = renderServices(m, ops, services);
    for (const service of rendered.files) ctx.emit(service.path, service.content);
    ctx.emit(`${dir}/${opts.clientName}.swift`, renderClient(m, [...services.values()]));
    ctx.emit(`${dir}/ApiAuth.swift`, renderAuth(m));
    ctx.emit(`${dir}/Exports.swift`, renderExports(ctx, core));
    const manifest = renderPackage(ctx, module, core);
    if (manifest !== undefined) ctx.emit('Package.swift', manifest);

    const header = ctx.writer().comment(ctx.headerLines('swift'), 'line').toString();
    for (const file of runtime) ctx.emit(`Sources/${core}/${file.name}`, header === '' ? file.source : `${header}\n${file.source}`);

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, module, file: `${dir}/Models/${fileBaseName(name, opts)}.swift` };
        },
        operation(operationId) {
          const op = rendered.operations.get(operationId);
          if (op === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return {
            service: op.typeName,
            property: op.property,
            method: op.method,
            withResponseMethod: op.withResponse,
            file: `${dir}/Services/${op.typeName}.swift`,
          };
        },
      },
    };
  },
});
