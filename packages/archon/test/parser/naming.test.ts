import { describe, expect, test } from 'vitest';
import { deriveOperationName } from '../../src/parser/naming.js';

describe('deriveOperationName', () => {
  test.each([
    ['GET', '/catalyst/v1/album/by/id/{id}', 'getCatalystV1AlbumByIdById'],
    ['POST', '/catalyst/v1/album', 'postCatalystV1Album'],
    ['GET', '/catalyst/v1.1/on-this-day', 'getCatalystV11OnThisDay'],
    ['DELETE', '/a/{b_c}', 'deleteAByBC'],
    ['GET', '/', 'get'],
  ])('%s %s -> %s', (method, path, expected) => {
    expect(deriveOperationName(method, path)).toBe(expected);
  });
});
