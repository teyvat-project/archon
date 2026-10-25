import type { PluginContext } from '../../plugin/types.js';
import { block, csFile, SER } from './emit.js';
import type { CSharpPluginOptions } from './index.js';
import type { CsTypeResolver } from './types.js';

export const JSON_CONTEXT = 'ApiJsonContext';

/** `ApiJsonContext.cs`: the source-generated serializer context for every registered type. */
export function renderJsonContext(ctx: PluginContext<CSharpPluginOptions>, resolver: CsTypeResolver): string {
  const w = csFile(ctx, resolver.namespace);
  w.line('/// <summary>Source-generated System.Text.Json metadata for the SDK\'s types.</summary>');
  w.line(`[${SER}.JsonSourceGenerationOptions(AllowOutOfOrderMetadataProperties = true)]`);
  for (const { code, property } of resolver.registered()) {
    w.line(`[${SER}.JsonSerializable(typeof(${code}), TypeInfoPropertyName = "${property}")]`);
  }
  block(w, `public partial class ${JSON_CONTEXT} : ${SER}.JsonSerializerContext`, () => {});
  return w.toString();
}
