import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin, type PluginFactory } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NamingRule } from '../csharp/index.js';
import { renderAuth, renderClient, renderLib } from './client.js';
import { Containment, planUnions, renderModels } from './models.js';
import { buildNames } from './names.js';
import { renderProject } from './project.js';
import { readRsRuntime, vendorRuntimeFile } from './runtime.js';
import { buildServiceNames, renderServices, selectOperations } from './services.js';
import { RsTypeResolver } from './types.js';

export interface RustPluginOptions {
  /** Subdirectory of `output.path`. Default `'rust'`. */
  output: string;
  /** Name of the client struct (its builder is `<clientName>Builder`). Default `'ApiClient'`. */
  clientName: string;
  /**
   * `Cargo.toml` metadata; `false` emits no `Cargo.toml` (the sources still form a crate root). `undefined` derives it
   * from the document (name = title in kebab-case, version = `info.version` when it is a semantic version).
   * `dependencies` are written into `[dependencies]` as given (e.g. `'chrono = { version = "0.4", features = ["serde"] }'`).
   */
  package:
    | false
    | { name?: string; version?: string; description?: string; license?: string; authors?: string[]; repository?: string; dependencies?: string[] }
    | undefined;
  /** Defaults: type PascalCase, method snake_case, property snake_case, file = type name in snake_case. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /** Keys `'kind:format'` (e.g. `'string:date-time'`) or `'kind'` (e.g. `'integer'`); values are Rust types. */
  typeMappings: Record<string, string>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    /** The returned Rust type is used as-is (`Option` is still added for optional / nullable usages). */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => string | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface RustPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; path: string; file: string };
    operation(operationId: string): {
      service: string;
      accessor: string;
      method: string;
      builder: string;
      error: string | undefined;
      module: string;
      file: string;
    };
  };
}

export const rust: PluginFactory<RustPluginOptions, RustPluginAPI> = definePlugin<RustPluginOptions, RustPluginAPI>({
  name: 'rust',
  defaults: {
    output: 'rust',
    clientName: 'ApiClient',
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'snake_case' }, property: { case: 'snake_case' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readRsRuntime(resolveRuntimeDir('rust', { marker: 'client.rs' }));
    const ops = selectOperations(ctx.ir.operations, opts);
    const services = buildServiceNames(ops);
    const names = buildNames(ctx.ir, opts, [opts.clientName, `${opts.clientName}Builder`, 'ApiAuth']);
    const resolver = new RsTypeResolver(ctx.ir, names, opts, ctx.diagnostics);
    const containment = new Containment(ctx.ir, resolver);
    const unions = planUnions(ctx.ir, resolver, containment);

    for (const model of renderModels(ctx, names, resolver, containment, unions)) ctx.emit(model.path, model.content);
    const rendered = renderServices(ctx, ops, services, names, resolver);
    for (const service of rendered.files) ctx.emit(service.path, service.content);
    ctx.emit('src/client.rs', renderClient(ctx, [...services.values()]));
    ctx.emit('src/auth.rs', renderAuth(ctx));
    ctx.emit('src/lib.rs', renderLib(ctx));
    for (const file of renderProject(ctx)) ctx.emit(file.file, file.content);

    const header = ctx.writer().comment(ctx.headerLines('rust'), 'line').toString();
    for (const file of runtime.map(vendorRuntimeFile)) {
      ctx.emit(`src/core/${file.name}`, header === '' ? file.source : `${header}\n${file.source}`);
    }

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, path: `crate::models::${name}`, file: `src/models/${names.modules.get(schemaName)}.rs` };
        },
        operation(operationId) {
          const op = rendered.operations.get(operationId);
          if (op === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return {
            service: op.struct,
            accessor: op.accessor,
            method: op.method,
            builder: op.builder,
            error: op.error,
            module: `crate::services::${op.module}`,
            file: `src/services/${op.module}.rs`,
          };
        },
      },
    };
  },
});
