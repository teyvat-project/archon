import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin, type PluginFactory } from '../../plugin/define.js';
import { resolveRuntimeDir } from '../../plugin/runtime.js';
import type { NamingRule } from '../csharp/index.js';
import { planUnions, renderModels } from './models.js';
import { buildNames, packageDir, resolvePackageName } from './names.js';
import { readKtRuntime, rewritePackage, runtimeTypeNames } from './runtime.js';
import { KtTypeResolver, type KtTypeMapping } from './types.js';

export interface KotlinPluginOptions {
  /** Subdirectory of `output.path`. Default `'kotlin'`. */
  output: string;
  /** Root package. Default: the title with each `.`-separated part reduced to lower-case letters and digits. */
  packageName: string | undefined;
  /** Name of the client class. Default `'ApiClient'`. */
  clientName: string;
  /**
   * Gradle metadata; `false` emits no Gradle files. `undefined` derives it from the document
   * (group = package name, name = title in kebab-case, version = `info.version`).
   */
  package: false | { group?: string; name?: string; version?: string; description?: string; dependencies?: string[] } | undefined;
  /** Defaults: type PascalCase, method camelCase, property camelCase, file = type name. */
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
  /**
   * Keys `'kind:format'` (e.g. `'string:date-time'`) or `'kind'` (e.g. `'integer'`). A string value is a Kotlin type
   * whose serializer is `<type>.serializer()`; otherwise give both.
   */
  typeMappings: Record<string, KtTypeMapping>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
    fileName?: (typeName: string) => string | undefined;
    /** The returned Kotlin type is used as-is (nullability is still added for optional / nullable usages). */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => KtTypeMapping | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface KotlinPluginAPI {
  symbols: {
    typeOf(schemaName: string): { name: string; packageName: string; file: string };
    operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string };
  };
}

export const kotlin: PluginFactory<KotlinPluginOptions, KotlinPluginAPI> = definePlugin<KotlinPluginOptions, KotlinPluginAPI>({
  name: 'kotlin',
  defaults: {
    output: 'kotlin',
    packageName: undefined,
    clientName: 'ApiClient',
    package: undefined,
    naming: { type: { case: 'PascalCase' }, method: { case: 'camelCase' }, property: { case: 'camelCase' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: () => ({ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readKtRuntime(resolveRuntimeDir('kotlin', { marker: 'main/kotlin/archon/runtime/ApiClientCore.kt' }));
    const runtimeNames = runtimeTypeNames(runtime);
    const packageName = resolvePackageName(ctx.ir, opts);
    const dir = packageDir(packageName);
    const names = buildNames(ctx.ir, opts, [...runtimeNames, opts.clientName, `${opts.clientName}Options`, 'ApiAuth']);
    const resolver = new KtTypeResolver(ctx.ir, names, opts, ctx.diagnostics, packageName);
    const plan = planUnions(ctx.ir, names, resolver);

    for (const model of renderModels(ctx, names, resolver, plan, runtimeNames)) ctx.emit(model.path, model.content);

    const header = ctx.writer().comment(ctx.headerLines('kotlin'), 'line').toString();
    for (const file of runtime) {
      const source = rewritePackage(file.source, packageName);
      ctx.emit(`${dir}/core/${file.name}`, header === '' ? source : `${header}\n${source}`);
    }

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.types.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, packageName: `${packageName}.models`, file: `${dir}/models/${names.files.get(schemaName)}.kt` };
        },
        operation(operationId) {
          throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
        },
      },
    };
  },
});
