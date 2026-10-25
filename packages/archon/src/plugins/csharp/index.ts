import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NameCase } from '../../writer/naming.js';
import { JSON_CONTEXT, renderJsonContext } from './json-context.js';
import { planUnions, renderModels } from './models.js';
import { renderAuth, renderClient } from './client.js';
import { buildNames, fileBaseName, resolveNamespace } from './names.js';
import { renderProject } from './project.js';
import { readCsRuntime, rewriteNamespace, runtimeTypeNames } from './runtime.js';
import { buildServiceNames, renderServices, selectOperations } from './services.js';
import { CsTypeResolver, isDeclared } from './types.js';

export type NamingRule = { case?: NameCase; name?: string | ((name: string) => string) };

export interface CSharpPluginOptions {
  /** Subdirectory of `output.path`. Default `'csharp'`. */
  output: string;
  /** Root namespace. Default: the title with each `.`-separated part in PascalCase. */
  namespace: string | undefined;
  /** Name of the client class. Default `'ApiClient'`. */
  clientName: string;
  /**
   * `.csproj` metadata; `false` emits no project file. `undefined` derives it from the document
   * (name = namespace, version = `info.version`).
   */
  package: false | { name?: string; version?: string; description?: string; authors?: string; license?: string } | undefined;
  /** Defaults: type PascalCase, method `{ case: 'PascalCase', name: '{{name}}Async' }`, property PascalCase, file = type name. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /** Keys `'kind:format'` (e.g. `'string:uuid'`) or `'kind'` (e.g. `'integer'`); values are C# type expressions. */
  typeMappings: Record<string, string>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    /** The returned C# type is used as-is (nullability is still added for optional / nullable usages). */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => string | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface CSharpPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; namespace: string; file: string };
    operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string };
  };
}

/** Names the generated code itself uses in the root namespace. */
const FIXED_NAMES = ['Core', JSON_CONTEXT, 'ApiAuth'];

export const csharp = definePlugin<CSharpPluginOptions, CSharpPluginAPI>({
  name: 'csharp',
  defaults: {
    output: 'csharp',
    namespace: undefined,
    clientName: 'ApiClient',
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'PascalCase', name: '{{name}}Async' }, property: { case: 'PascalCase' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readCsRuntime(resolveRuntimeDir('csharp', { marker: 'ApiClientCore.cs' }));
    const namespace = resolveNamespace(ctx.ir, opts);
    const ops = selectOperations(ctx.ir.operations, opts);
    const services = buildServiceNames(ops, opts.clientName);
    const reserved = [
      ...runtimeTypeNames(runtime),
      ...FIXED_NAMES,
      opts.clientName,
      `${opts.clientName}Options`,
      ...[...services.values()].map((s) => s.className),
    ];
    const names = buildNames(ctx.ir, opts, reserved);
    const resolver = new CsTypeResolver(ctx.ir, names, opts, ctx.diagnostics);
    const plan = planUnions(ctx.ir);

    for (const [schemaName, schema] of ctx.ir.schemas) {
      if (isDeclared(schema)) resolver.register(resolver.typeOf({ kind: 'ref', name: schemaName, nullable: false }, ['schemas', schemaName], 'model'));
    }
    for (const model of renderModels(ctx, names, resolver, plan)) ctx.emit(model.path, model.content);
    const rendered = renderServices(ctx, ops, services, names, resolver);
    for (const service of rendered.files) ctx.emit(service.path, service.content);
    ctx.emit(`${opts.clientName}.cs`, renderClient(ctx, namespace, [...services.values()]));
    ctx.emit('ApiAuth.cs', renderAuth(ctx, namespace));
    ctx.emit(`${JSON_CONTEXT}.cs`, renderJsonContext(ctx, resolver));
    const project = renderProject(ctx, namespace);
    if (project) ctx.emit(project.file, project.content);

    const header = ctx.writer().comment(ctx.headerLines('csharp'), 'line').toString();
    for (const file of runtime) {
      const source = rewriteNamespace(file.source, namespace);
      ctx.emit(`Core/${file.name}`, header === '' ? source : `${header}\n${source}`);
    }

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, namespace, file: `Models/${fileBaseName(name, opts)}.cs` };
        },
        operation(operationId) {
          const op = rendered.operations.get(operationId);
          if (op === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return {
            service: op.className,
            property: op.property,
            method: op.method,
            withResponseMethod: op.withResponse,
            file: `Services/${op.className}.cs`,
          };
        },
      },
    };
  },
});
