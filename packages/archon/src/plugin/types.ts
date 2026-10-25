import type { ResolvedConfig } from '../config/types.js';
import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument } from '../ir/types.js';

/** `path` is relative to `output.path`. */
export type EmittedFile = { path: string; content: string | Uint8Array };

export type IRRequirements = { hoistInlineObjects?: boolean; hoistInlineEnums?: boolean; hoistInlineUnions?: boolean };

export interface PluginContext<O> {
  ir: IRDocument;
  options: O;
  config: ResolvedConfig;
  outputDir: string;
  diagnostics: Diagnostics;
  emit(relativePath: string, content: string | Uint8Array): void;
  headerLines(language: string): string[];
  writer(opts?: { indent?: string }): import('../writer/code-writer.js').CodeWriter;
  plugin<API = unknown>(name: string): API;
}

export interface PluginDefinition<O, API> {
  name: string;
  defaults: O;
  dependencies?: string[];
  irRequirements?: (options: O) => IRRequirements;
  transformIR?: (ir: IRDocument, ctx: { options: O; diagnostics: Diagnostics }) => void;
  generate: (ctx: PluginContext<O>) => API | void | Promise<API | void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factories?: Record<string, (options?: any) => ArchonPlugin<any, any>>;
}

export interface ArchonPlugin<O, API> {
  name: string;
  options: O;
  definition: PluginDefinition<O, API>;
}
