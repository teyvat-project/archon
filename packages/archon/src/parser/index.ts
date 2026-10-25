import type { Diagnostics } from '../diagnostics.js';
import type { IRDocument } from '../ir/types.js';
import type { OpenAPIDocument } from '../loader/load.js';
import { parseOperations, parseSecuritySchemes, parseServers, type ParserHooks } from './operation.js';
import { detectVersion, parseComponentSchemas, type SchemaContext } from './schema.js';

export type { ParserHooks } from './operation.js';

export function parseDocument(
  doc: OpenAPIDocument,
  opts: { diagnostics: Diagnostics; hooks?: ParserHooks },
): IRDocument {
  const { diagnostics, hooks } = opts;
  const ctx: SchemaContext = { doc, version: detectVersion(doc), diagnostics, pointer: '#' };

  const info = doc['info'] as { title?: unknown; version?: unknown; description?: unknown } | undefined;
  const servers = parseServers(doc['servers']);

  return {
    info: {
      title: typeof info?.title === 'string' ? info.title : '',
      version: typeof info?.version === 'string' ? info.version : '',
      ...(typeof info?.description === 'string' && { description: info.description }),
    },
    servers: servers.length > 0 ? servers : [{ url: '/', variables: {} }],
    securitySchemes: parseSecuritySchemes(doc, diagnostics),
    schemas: parseComponentSchemas(doc, ctx),
    operations: parseOperations(doc, ctx, hooks),
  };
}
