import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin, type PluginFactory } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NamingRule } from '../csharp/index.js';
import { renderAuth, renderClient } from './client.js';
import { headerComment } from './emit.js';
import { planModels, renderModels } from './models.js';
import { buildNames, resolveModule, resolvePackageName } from './names.js';
import { renderProject } from './project.js';
import { readGoRuntime } from './runtime.js';
import { buildServiceNames, renderServices, selectOperations } from './services.js';
import { GoTypeResolver, type GoTypeMapping } from './types.js';

export interface GoPluginOptions {
  /** Subdirectory of `output.path`. Default `'go'`. */
  output: string;
  /** The module path of `go.mod` (the runtime is imported as `<module>/core`). Default: the package name. */
  module: string | undefined;
  /** The package name. Default: the title reduced to lower-case letters and digits. */
  packageName: string | undefined;
  /**
   * `go.mod` settings; `false` emits no `go.mod` (the SDK then lives inside another module, and `module` must be
   * its import path). `dependencies` are `require` lines (`'github.com/google/uuid v1.6.0'`).
   */
  package: false | { goVersion?: string; dependencies?: string[] } | undefined;
  /** Defaults: type, method and property PascalCase, file `<snake_case>_model`. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /**
   * Keys `'kind:format'` (e.g. `'string:uuid'`) or `'kind'` (e.g. `'integer'`). The value is a Go type, with the
   * import path it needs (`{ type: 'uuid.UUID', import: 'github.com/google/uuid' }`).
   */
  typeMappings: Record<string, GoTypeMapping>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    /** The returned Go type is used as is (optional / nullable usages still become pointers unless it is nilable). */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => GoTypeMapping | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface GoPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; importPath: string; file: string };
    operation(operationId: string): { service: string; field: string; method: string; params: string | undefined; file: string };
  };
}

export const go: PluginFactory<GoPluginOptions, GoPluginAPI> = definePlugin<GoPluginOptions, GoPluginAPI>({
  name: 'go',
  defaults: {
    output: 'go',
    module: undefined,
    packageName: undefined,
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'PascalCase' }, property: { case: 'PascalCase' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readGoRuntime(resolveRuntimeDir('go', { marker: 'client.go' }));
    const packageName = resolvePackageName(ctx.ir, opts);
    const module = resolveModule(packageName, opts);
    const ops = selectOperations(ctx.ir.operations, opts);
    const services = buildServiceNames(ops);
    const names = buildNames(ctx.ir, opts, [...services.values()].map((s) => s.typeName));
    const resolver = new GoTypeResolver(ctx.ir, names, opts, ctx.diagnostics);
    const plan = planModels(ctx.ir, names, resolver);

    for (const model of renderModels({ ctx, names, resolver, plan }, packageName, module)) ctx.emit(model.path, model.content);
    const rendered = renderServices(ctx, ops, services, names, resolver, packageName, module);
    for (const service of rendered.files) ctx.emit(service.path, service.content);
    ctx.emit('client.go', renderClient(ctx, packageName, module, [...services.values()]));
    ctx.emit('auth.go', renderAuth(ctx, packageName, module));
    for (const file of renderProject(ctx, module)) ctx.emit(file.file, file.content);

    const header = `${headerComment(ctx).join('\n')}\n\n`;
    for (const file of runtime) ctx.emit(`core/${file.name}`, header + file.source);

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, importPath: module, file: names.files.get(schemaName) as string };
        },
        operation(operationId) {
          const op = rendered.operations.get(operationId);
          if (op === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return { service: op.typeName, field: op.field, method: op.method, params: op.params, file: op.file };
        },
      },
    };
  },
});
