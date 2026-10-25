import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument } from '../ir/types.js';
import { flattenAllOf } from './all-of.js';
import { inferDiscriminators } from './discriminator.js';
import { applyFilters, removeOrphans, renameSchemas } from './filters.js';
import type { FiltersConfig } from './filters.js';
import { hoistInlineSchemas } from './hoist.js';
import type { HoistOptions } from './hoist.js';
import { splitReadWrite } from './read-write.js';
import type { ReadWriteOptions } from './read-write.js';

export type TransformsConfig = {
  enums?: 'root' | 'inline';
  inferDiscriminator?: boolean;
  readWrite?: ReadWriteOptions;
  schemaName?: string | ((name: string) => string);
};

/**
 * プラグインに依存しない共通パスを、applyFilters → flattenAllOf → inferDiscriminators →
 * hoist(enums のみ) → splitReadWrite → renameSchemas → removeOrphans の順に `ir` へ適用する。
 */
export function runCommonPasses(
  ir: IRDocument,
  opts: { filters?: FiltersConfig; transforms?: TransformsConfig; inlineSchemaName?: HoistOptions['nameHook'] },
  diagnostics: Diagnostics,
): void {
  const transforms = opts.transforms ?? {};

  applyFilters(ir, opts.filters, diagnostics);
  flattenAllOf(ir, diagnostics);
  if (transforms.inferDiscriminator !== false) inferDiscriminators(ir);
  if (transforms.enums === 'root') {
    const hoist: HoistOptions = { objects: false, enums: true };
    if (opts.inlineSchemaName) hoist.nameHook = opts.inlineSchemaName;
    hoistInlineSchemas(ir, hoist);
  }
  if (transforms.readWrite) splitReadWrite(ir, transforms.readWrite, diagnostics);
  renameSchemas(ir, transforms.schemaName, diagnostics);
  if (opts.filters?.orphans === false) removeOrphans(ir);
}

/** プラグインの要求に応じた hoist を `structuredClone(ir)` に適用して返す（元の IR は変更しない）。 */
export function runPluginPasses(
  ir: IRDocument,
  req: { hoistInlineObjects?: boolean; hoistInlineEnums?: boolean; hoistInlineUnions?: boolean },
  nameHook?: HoistOptions['nameHook'],
): IRDocument {
  const out = structuredClone(ir);
  const hoist: HoistOptions = {
    objects: req.hoistInlineObjects === true,
    enums: req.hoistInlineEnums === true,
    unions: req.hoistInlineUnions === true,
  };
  if (nameHook) hoist.nameHook = nameHook;
  hoistInlineSchemas(out, hoist);
  return out;
}
