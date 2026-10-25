export const version = '0.1.0';

export type * from './ir/types.js';
export type { SchemaPath } from './ir/walk.js';
export { ArchonError, Diagnostics } from './diagnostics.js';
export type { Diagnostic } from './diagnostics.js';
export { parseDocument } from './parser/index.js';
export type { ParserHooks } from './parser/index.js';
export { runCommonPasses, runPluginPasses } from './passes/index.js';
export type { TransformsConfig } from './passes/index.js';
export type { ReadWriteOptions } from './passes/read-write.js';
export type { FiltersConfig } from './passes/filters.js';
export type { HoistOptions } from './passes/hoist.js';
