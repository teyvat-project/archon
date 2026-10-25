import { ArchonError } from '../../diagnostics.js';
import type { IROperation, IRSchema } from '../../ir/types.js';
import type { SchemaPath } from '../../ir/walk.js';
import { definePlugin } from '../../plugin/define.js';
import type { NameCase } from '../../writer/naming.js';
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
    const names = buildTypeNameTable(ctx.ir, ctx.options);
    ctx.emit(TYPES_FILE, renderTypes(ctx, names));
    return {
      symbols: {
        typeOf(schemaName) {
          const name = names.get(schemaName);
          if (name === undefined) throw new ArchonError('unknown-schema', `Unknown schema "${schemaName}".`);
          return { name, file: TYPES_FILE };
        },
        operation() {
          throw new ArchonError('not-implemented', 'symbols.operation is not implemented yet.');
        },
      },
    };
  },
});
