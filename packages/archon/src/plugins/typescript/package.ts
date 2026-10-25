import type { IRDocument } from '../../ir/types.js';
import { toCase } from '../../writer/naming.js';
import type { TypeScriptPluginOptions } from './index.js';

/**
 * 生成する `package.json` の内容（`package: false` なら `undefined`）。
 * 未指定の name / version は info から補う（name = `toCase(info.title, 'kebab-case')`, version = `info.version`）。
 * 実行時依存は持たない。
 */
export function renderPackageJson(ir: IRDocument, opts: TypeScriptPluginOptions): string | undefined {
  if (opts.package === false) return undefined;
  const given: Partial<Exclude<TypeScriptPluginOptions['package'], false | undefined>> = opts.package ?? {};
  const manifest = {
    name: given.name ?? (toCase(ir.info.title, 'kebab-case') || 'api-client'),
    version: given.version ?? (ir.info.version || '0.0.0'),
    ...(given.description !== undefined && { description: given.description }),
    ...(given.license !== undefined && { license: given.license }),
    type: 'module',
    exports: { '.': './index.ts' },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * 生成する `tsconfig.json` の内容（`package: false` なら `undefined`）。
 * importExtension が `.ts` なら `allowImportingTsExtensions`、`''` なら Bundler 解決にする。
 */
export function renderTsconfig(opts: TypeScriptPluginOptions): string | undefined {
  if (opts.package === false) return undefined;
  const bundler = opts.importExtension === '';
  const compilerOptions = {
    strict: true,
    target: 'ES2022',
    lib: ['ES2022', 'DOM'],
    module: bundler ? 'ESNext' : 'NodeNext',
    moduleResolution: bundler ? 'Bundler' : 'NodeNext',
    ...(opts.importExtension === '.ts' && { allowImportingTsExtensions: true }),
    noEmit: true,
  };
  return `${JSON.stringify({ compilerOptions, include: ['**/*.ts'] }, null, 2)}\n`;
}
