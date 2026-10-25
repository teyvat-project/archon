import { describe, expect, test } from 'vitest';
import type { IRDocument, IRSchema } from '../../src/ir/types.js';
import { collectRefs, mapSchema, visitSchemas } from '../../src/ir/walk.js';

const base = { nullable: false } as const;
const str: IRSchema = { ...base, kind: 'string' };
const ref = (name: string): IRSchema => ({ ...base, kind: 'ref', name });

function doc(partial: Partial<IRDocument> = {}): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(),
    operations: [],
    ...partial,
  };
}

describe('visitSchemas', () => {
  test('visits nested object/array/union children with paths', () => {
    const x: IRSchema = {
      ...base,
      kind: 'object',
      properties: [
        { name: 'a', required: true, schema: { ...base, kind: 'array', items: str } },
        {
          name: 'u',
          required: false,
          schema: { ...base, kind: 'union', variants: [str, { ...base, kind: 'boolean' }] },
        },
      ],
    };
    const paths: string[][] = [];
    visitSchemas(doc({ schemas: new Map([['X', x]]) }), (_s, p) => paths.push(p));
    expect(paths).toContainEqual(['schemas', 'X']);
    expect(paths).toContainEqual(['schemas', 'X', 'properties', 'a']);
    expect(paths).toContainEqual(['schemas', 'X', 'properties', 'a', 'items']);
    expect(paths).toContainEqual(['schemas', 'X', 'properties', 'u', 'variants', '1']);
  });

  test('does not follow refs', () => {
    const a: IRSchema = {
      ...base,
      kind: 'object',
      properties: [{ name: 'b', required: true, schema: ref('B') }],
    };
    const b: IRSchema = { ...base, kind: 'object', properties: [{ name: 'a', required: true, schema: ref('A') }] };
    const visited: IRSchema[] = [];
    visitSchemas(doc({ schemas: new Map([['A', a], ['B', b]]) }), (s) => visited.push(s));
    // A, A.b(ref), B, B.a(ref) — refs are visited as nodes but never expanded
    expect(visited).toHaveLength(4);
  });

  test('walks operation parameters, request bodies, responses and response headers', () => {
    const d = doc({
      operations: [
        {
          id: 'POST /x/{id}',
          name: 'postX',
          method: 'post',
          path: '/x/{id}',
          tags: [],
          deprecated: false,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              deprecated: false,
              schema: str,
              style: 'simple',
              explode: false,
              allowReserved: false,
            },
          ],
          requestBody: {
            required: true,
            contents: [{ mediaType: 'application/json', kind: 'json', schema: str }],
          },
          responses: [
            {
              status: 200,
              headers: new Map([['X-Rate', str]]),
              contents: [{ mediaType: 'application/json', kind: 'json', schema: str }],
            },
          ],
          security: [],
        },
      ],
    });
    const paths: string[][] = [];
    visitSchemas(d, (_s, p) => paths.push(p));
    expect(paths).toEqual([
      ['operations', 'POST /x/{id}', 'parameters', 'id'],
      ['operations', 'POST /x/{id}', 'requestBody', 'application/json'],
      ['operations', 'POST /x/{id}', 'responses', '200', 'headers', 'X-Rate'],
      ['operations', 'POST /x/{id}', 'responses', '200', 'application/json'],
    ]);
  });
});

describe('mapSchema', () => {
  test('replaces children before parents', () => {
    const input: IRSchema = { ...base, kind: 'array', items: ref('A') };
    const order: string[] = [];
    const out = mapSchema(input, (s) => {
      order.push(s.kind);
      return s.kind === 'ref' ? str : s;
    });
    expect(order).toEqual(['ref', 'array']);
    expect(out).toMatchObject({ kind: 'array', items: { kind: 'string' } });
    expect(input).toMatchObject({ items: { kind: 'ref' } }); // input is not mutated
  });

  test('maps through objects, additionalProperties, tuples, unions and intersections', () => {
    const input: IRSchema = {
      ...base,
      kind: 'object',
      properties: [{ name: 'p', required: true, schema: ref('A') }],
      additionalProperties: {
        ...base,
        kind: 'union',
        variants: [ref('B'), { ...base, kind: 'tuple', items: [ref('C')], rest: ref('D') }],
      },
    };
    const out = mapSchema(input, (s) => (s.kind === 'ref' ? { ...base, kind: 'boolean' } : s));
    expect(collectRefs(out).size).toBe(0);
  });
});

describe('collectRefs', () => {
  test('finds refs inside union and additionalProperties', () => {
    const s: IRSchema = {
      ...base,
      kind: 'object',
      properties: [
        { name: 'u', required: true, schema: { ...base, kind: 'union', variants: [ref('A'), str] } },
      ],
      additionalProperties: ref('B'),
    };
    expect(collectRefs(s)).toEqual(new Set(['A', 'B']));
  });
});
