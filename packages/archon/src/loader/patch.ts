import type { Diagnostics } from '../diagnostics.js';
import type { OpenAPIDocument } from './load.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PatchConfig = {
  document?: (doc: OpenAPIDocument) => void;
  schemas?: Record<string, (schema: any) => void>;
  operations?: Record<string, (operation: any) => void>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function applyPatch(doc: OpenAPIDocument, patch: PatchConfig | undefined, diagnostics: Diagnostics): void {
  if (!patch) return;

  patch.document?.(doc);

  for (const [name, fn] of Object.entries(patch.schemas ?? {})) {
    const schema = doc['components']?.schemas?.[name];
    if (schema === undefined || schema === null) {
      diagnostics.warn('patch-target-missing', `patch.schemas: schema "${name}" not found`, `#/components/schemas/${name}`);
      continue;
    }
    fn(schema);
  }

  for (const [key, fn] of Object.entries(patch.operations ?? {})) {
    const operation = findOperation(doc, key);
    if (!operation) {
      diagnostics.warn('patch-target-missing', `patch.operations: operation "${key}" not found`);
      continue;
    }
    fn(operation);
  }
}

function findOperation(doc: OpenAPIDocument, key: string) {
  const match = /^(\S+)\s+(\S.*)$/.exec(key.trim());
  if (!match) return undefined;
  const method = match[1]!.toLowerCase();
  const path = match[2]!;
  if (!HTTP_METHODS.has(method)) return undefined;
  const operation = doc['paths']?.[path]?.[method];
  return operation !== null && typeof operation === 'object' ? operation : undefined;
}
