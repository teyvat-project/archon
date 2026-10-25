import { toCase } from '../writer/naming.js';

/**
 * `method` + パスセグメントから操作名を導出する。`{x}` は `By` + `X`。
 * 例: `GET /catalyst/v1/album/by/id/{id}` → `getCatalystV1AlbumByIdById`
 */
export function deriveOperationName(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\{([^}]*)\}/g, ' by $1 '));
  return toCase([method, ...segments].join(' '), 'camelCase');
}
