import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin } from '../../plugin/define.js';
import type { NameCase } from '../../writer/naming.js';
import { CLIENT_EXPORTS, renderClient, renderIndex } from './client.js';
import { renderPackageJson, renderTsconfig } from './package.js';
import { readRuntime, resolveRuntimeDir, rewriteImportExtensions, runtimeExportNames } from './runtime.js';
import { buildSdkModel, renderSdk, SDK_EXPORTS } from './sdk.js';
import { planTransformers, renderTransformers } from './transformers.js';
import { buildTypeNameTable, renderTypes } from './types.js';

export type NamingRule = { case?: NameCase; name?: string | ((name: string) => string) };

export interface TypeScriptPluginOptions {
  /** `output.path` からのサブディレクトリ。既定 `'typescript'`。 */
  output: string;
  /**
   * 生成するマニフェスト（package.json / tsconfig.json）の情報。`false` で生成しない。
   * 既定の `undefined` は「info から導出する」を表す（name = `toCase(info.title, 'kebab-case')`, version = `info.version`）。
   */
  package: false | { name: string; version: string; description?: string; license?: string } | undefined;
  /** SDK の形。既定 `'functions'`。 */
  sdk: { style: 'functions' | 'class' };
  /** named enum の宣言形式。inline enum は常にリテラル union。既定 `'union'`。 */
  enums: 'union' | 'const' | 'enum';
  /** `date-time` / `date` の型。既定 `'string'`。 */
  dates: 'string' | 'Date';
  /** 生成コードの相対 import に付ける拡張子。既定 `'.js'`。 */
  importExtension: '.js' | '.ts' | '';
  /** 既定: type は PascalCase、method は camelCase。プロパティ名はワイヤ形式と一致させるため変更できない。 */
  naming: { type?: NamingRule; method?: NamingRule };
  /** キーは `'kind:format'`（例 `'string:uuid'`）、値は TS の型式。nullable なら `| null` が付く。 */
  typeMappings: Record<string, string>;
  hooks: {
    typeName?: (name: string) => string | undefined;
    methodName?: (op: IROperation) => string | undefined;
    /** 返した型式をそのまま使う（nullable の `| null` も付けない）。 */
    typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => string | undefined;
  };
  include?: string[];
  exclude?: string[];
}

export interface TypeScriptPluginAPI {
  symbols: {
    /** `file` は出力ディレクトリ相対（例 `'types.gen.ts'`）。 */
    typeOf(schemaName: string): { name: string; file: string };
    /** `functionName` は class スタイルでは `'<Class>.<method>'`。include / exclude で除外した操作は不明扱い。 */
    operation(operationId: string): {
      functionName: string;
      dataType: string;
      responseType: string;
      errorType: string;
      file: string;
    };
  };
}

const TYPES_FILE = 'types.gen.ts';
const SDK_FILE = 'sdk.gen.ts';

/**
 * 生成コードが同じスコープで使う名前。types.gen.ts の型名にも sdk.gen.ts の操作名にも使わない
 * （index.ts の `export *` や sdk.gen.ts の import と衝突させないため）。
 * `AbortSignal` は sdk.gen.ts の Options が参照するグローバル型。
 */
const GENERATED_NAMES = [...CLIENT_EXPORTS, ...SDK_EXPORTS, 'AbortSignal'];

export const typescript = definePlugin<TypeScriptPluginOptions, TypeScriptPluginAPI>({
  name: 'typescript',
  defaults: {
    output: 'typescript',
    package: undefined,
    sdk: { style: 'functions' },
    enums: 'union',
    dates: 'string',
    importExtension: '.js',
    naming: { type: { case: 'PascalCase' }, method: { case: 'camelCase' } },
    typeMappings: {},
    hooks: {},
  },
  irRequirements: (opts) => ({ hoistInlineObjects: false, hoistInlineEnums: opts.enums !== 'union' }),
  generate(ctx) {
    const opts = ctx.options;
    const runtime = readRuntime(resolveRuntimeDir('typescript'));
    const reserved = [...runtimeExportNames(runtime), ...GENERATED_NAMES];
    const names = buildTypeNameTable(ctx.ir, opts, reserved);
    const plan = opts.dates === 'Date' ? planTransformers(ctx.ir, names, opts) : undefined;
    const sdk = buildSdkModel(ctx, [...reserved, ...names.values(), ...(plan?.named.values() ?? [])], plan);
    const operations = new Map(sdk.operations.map((m) => [m.op.id, m.names]));

    ctx.emit(TYPES_FILE, renderTypes(ctx, names));
    ctx.emit(SDK_FILE, renderSdk(ctx, sdk, names));
    ctx.emit('client.gen.ts', renderClient(ctx));
    if (plan) ctx.emit('transformers.gen.ts', renderTransformers(ctx, plan, sdk.extraTransformers));
    ctx.emit('index.ts', renderIndex(ctx));

    const header = ctx.writer().comment(ctx.headerLines('typescript'), 'line').toString();
    for (const file of runtime) {
      const source = rewriteImportExtensions(file.source, opts.importExtension);
      ctx.emit(`core/${file.name}`, header === '' ? source : `${header}\n${source}`);
    }

    const packageJson = renderPackageJson(ctx.ir, opts);
    const tsconfig = renderTsconfig(opts);
    if (packageJson !== undefined) ctx.emit('package.json', packageJson);
    if (tsconfig !== undefined) ctx.emit('tsconfig.json', tsconfig);

    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, file: TYPES_FILE };
        },
        operation(operationId) {
          const n = operations.get(operationId);
          if (n === undefined) {
            throw new ArchonError('unknown-operation', `Unknown operation "${operationId}" (or excluded from the SDK).`);
          }
          return {
            functionName: n.className === undefined ? n.method : `${n.className}.${n.method}`,
            dataType: n.dataType,
            responseType: n.responseType,
            errorType: n.errorType,
            file: SDK_FILE,
          };
        },
      },
    };
  },
});
