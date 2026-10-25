import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ArchonError, Diagnostics } from '../../src/diagnostics.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import {
  detectVersion,
  parseComponentSchemas,
  parseSchema,
  type SchemaContext,
} from '../../src/parser/schema.js';

const P = '#/x';

function setup(doc: Partial<OpenAPIDocument> = {}, version: '3.0' | '3.1' = '3.1') {
  const diagnostics = new Diagnostics();
  const full = { openapi: version === '3.1' ? '3.1.0' : '3.0.3', ...doc } as OpenAPIDocument;
  const ctx: SchemaContext = { doc: full, version, diagnostics, pointer: P };
  return { ctx, diagnostics, doc: full };
}

const comps = (names: string[]): Partial<OpenAPIDocument> => ({
  components: { schemas: Object.fromEntries(names.map((n) => [n, { type: 'object' }])) },
});

const base = { nullable: false, origin: P };
const at = (suffix: string) => ({ nullable: false, origin: `${P}/${suffix}` });

describe('parseSchema nullable normalization', () => {
  test('normalizes 3.1 type array with null to nullable', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: ['string', 'null'] }, ctx)).toEqual({ kind: 'string', ...base, nullable: true });
  });

  test('normalizes 3.0 nullable', () => {
    const { ctx } = setup({}, '3.0');
    expect(parseSchema({ type: 'integer', format: 'int64', nullable: true }, ctx)).toEqual({
      kind: 'integer',
      format: 'int64',
      ...base,
      nullable: true,
    });
  });

  test('normalizes anyOf [X, null] to nullable X', () => {
    const { ctx } = setup(comps(['A']));
    expect(parseSchema({ anyOf: [{ $ref: '#/components/schemas/A' }, { type: 'null' }] }, ctx)).toEqual({
      kind: 'ref',
      name: 'A',
      ...base,
      nullable: true,
    });
  });

  test('keeps a union when more than one non-null variant remains', () => {
    const { ctx } = setup();
    expect(parseSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] }, ctx)).toEqual({
      kind: 'union',
      variants: [
        { kind: 'string', ...at('oneOf/0') },
        { kind: 'integer', ...at('oneOf/1') },
      ],
      ...base,
      nullable: true,
    });
  });

  test('converts multi-type array to union', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: ['string', 'number'] }, ctx)).toEqual({
      kind: 'union',
      variants: [
        { kind: 'string', ...base },
        { kind: 'number', ...base },
      ],
      ...base,
    });
  });

  test('treats a lone null type as the null kind', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'null' }, ctx)).toEqual({ kind: 'null', ...base });
  });
});

describe('parseSchema primitives and enums', () => {
  test('parses enum with null into nullable enum', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'string', enum: ['a', 'b', null] }, ctx)).toEqual({
      kind: 'enum',
      base: 'string',
      values: ['a', 'b'],
      ...base,
      nullable: true,
    });
  });

  test('keeps a single-value enum as enum, and const as const', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'string', enum: ['standard'] }, ctx)).toEqual({
      kind: 'enum',
      base: 'string',
      values: ['standard'],
      ...base,
    });
    expect(parseSchema({ const: 'x' }, ctx)).toEqual({ kind: 'const', value: 'x', ...base });
  });

  test('infers enum base from values when type is missing', () => {
    const { ctx } = setup();
    expect(parseSchema({ enum: [1, 2] }, ctx)).toMatchObject({ kind: 'enum', base: 'integer', values: [1, 2] });
    expect(parseSchema({ enum: [1.5, 2] }, ctx)).toMatchObject({ kind: 'enum', base: 'number' });
    expect(parseSchema({ enum: ['a'] }, ctx)).toMatchObject({ kind: 'enum', base: 'string' });
  });

  test('keeps string format verbatim with pattern and length bounds', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'string', format: 'uuid', pattern: '^a', minLength: 1, maxLength: 5 }, ctx)).toEqual({
      kind: 'string',
      format: 'uuid',
      pattern: '^a',
      minLength: 1,
      maxLength: 5,
      ...base,
    });
  });

  test('drops integer/number formats outside the IR vocabulary', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'integer', format: 'unixtime' }, ctx)).toEqual({ kind: 'integer', ...base });
    expect(parseSchema({ type: 'number', format: 'decimal' }, ctx)).toEqual({ kind: 'number', ...base });
    expect(parseSchema({ type: 'number', format: 'float' }, ctx)).toEqual({ kind: 'number', format: 'float', ...base });
  });

  test('parses binary from format and contentMediaType', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'string', format: 'binary' }, ctx)).toEqual({ kind: 'binary', ...base });
    expect(parseSchema({ type: 'string', contentMediaType: 'image/png' }, ctx)).toEqual({ kind: 'binary', ...base });
    expect(parseSchema({ type: 'string', contentEncoding: 'base64' }, ctx)).toEqual({ kind: 'binary', ...base });
  });

  test('copies metadata onto the schema base', () => {
    const { ctx } = setup();
    expect(
      parseSchema(
        { type: 'string', title: 'T', description: 'D', deprecated: true, default: 'z', example: 'e', readOnly: true },
        ctx,
      ),
    ).toEqual({
      kind: 'string',
      title: 'T',
      description: 'D',
      deprecated: true,
      default: 'z',
      example: 'e',
      readOnly: true,
      ...base,
    });
  });

  test('ignores 3.0 boolean exclusiveMinimum without diagnostics', () => {
    const { ctx, diagnostics } = setup({}, '3.0');
    expect(parseSchema({ type: 'integer', minimum: 0, exclusiveMinimum: true }, ctx)).toEqual({
      kind: 'integer',
      ...base,
    });
    expect(diagnostics.entries).toEqual([]);
  });
});

describe('parseSchema objects and arrays', () => {
  test('parses object with required, additionalProperties true', () => {
    const { ctx } = setup();
    expect(
      parseSchema(
        {
          type: 'object',
          properties: { id: { type: 'string', readOnly: true }, n: { type: 'integer' } },
          required: ['id'],
          additionalProperties: true,
        },
        ctx,
      ),
    ).toEqual({
      kind: 'object',
      properties: [
        { name: 'id', required: true, schema: { kind: 'string', readOnly: true, ...at('properties/id') } },
        { name: 'n', required: false, schema: { kind: 'integer', ...at('properties/n') } },
      ],
      additionalProperties: { kind: 'unknown', ...at('additionalProperties') },
      ...base,
    });
  });

  test('distinguishes additionalProperties absent, {} and false', () => {
    const { ctx } = setup();
    const ap = (node: object) => (parseSchema(node, ctx) as { additionalProperties?: unknown }).additionalProperties;
    expect(ap({ type: 'object' })).toBeUndefined();
    expect(ap({ type: 'object', additionalProperties: {} })).toMatchObject({ kind: 'unknown' });
    expect(ap({ type: 'object', additionalProperties: false })).toBe(false);
    expect(ap({ type: 'object', additionalProperties: { type: 'string' } })).toMatchObject({ kind: 'string' });
  });

  test('infers kind when type is missing', () => {
    const { ctx } = setup();
    expect(parseSchema({ properties: { a: { type: 'string' } } }, ctx)).toMatchObject({ kind: 'object' });
    expect(parseSchema({ additionalProperties: false }, ctx)).toMatchObject({ kind: 'object' });
    expect(parseSchema({ items: { type: 'string' } }, ctx)).toMatchObject({ kind: 'array' });
    expect(parseSchema({ description: 'whatever' }, ctx)).toEqual({ kind: 'unknown', description: 'whatever', ...base });
    expect(parseSchema({}, ctx)).toEqual({ kind: 'unknown', ...base });
    expect(parseSchema(true, ctx)).toEqual({ kind: 'unknown', ...base });
  });

  test('parses arrays and 3.1 prefixItems tuples', () => {
    const { ctx } = setup();
    expect(parseSchema({ type: 'array', items: { type: 'string' }, uniqueItems: true }, ctx)).toEqual({
      kind: 'array',
      items: { kind: 'string', ...at('items') },
      uniqueItems: true,
      ...base,
    });
    expect(parseSchema({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ctx)).toEqual({
      kind: 'tuple',
      items: [{ kind: 'string', ...at('prefixItems/0') }],
      rest: { kind: 'integer', ...at('items') },
      ...base,
    });
  });

  test('escapes JSON pointer segments in property origins', () => {
    const { ctx } = setup();
    const s = parseSchema({ type: 'object', properties: { 'a/b': { type: 'string' } } }, ctx);
    expect(s.kind === 'object' && s.properties[0]?.schema.origin).toBe(`${P}/properties/a~1b`);
  });
});

describe('parseSchema composition', () => {
  test('parses allOf as intersection', () => {
    const { ctx } = setup(comps(['A']));
    expect(parseSchema({ allOf: [{ $ref: '#/components/schemas/A' }, { type: 'object' }] }, ctx)).toEqual({
      kind: 'intersection',
      members: [
        { kind: 'ref', name: 'A', ...at('allOf/0') },
        { kind: 'object', properties: [], ...at('allOf/1') },
      ],
      ...base,
    });
  });

  test('adds sibling properties to the intersection members', () => {
    const { ctx } = setup(comps(['A']));
    const s = parseSchema({ allOf: [{ $ref: '#/components/schemas/A' }], properties: { x: { type: 'string' } } }, ctx);
    expect(s.kind === 'intersection' && s.members.map((m) => m.kind)).toEqual(['object', 'ref']);
  });

  test('parses oneOf with discriminator mapping', () => {
    const { ctx } = setup(comps(['A', 'B', 'C']));
    const s = parseSchema(
      {
        oneOf: [
          { $ref: '#/components/schemas/A' },
          { $ref: '#/components/schemas/B' },
          { $ref: '#/components/schemas/C' },
        ],
        discriminator: {
          propertyName: 'type',
          mapping: { a: '#/components/schemas/A', b: 'B' },
        },
      },
      ctx,
    );
    expect(s).toEqual({
      kind: 'union',
      variants: [
        { kind: 'ref', name: 'A', ...at('oneOf/0') },
        { kind: 'ref', name: 'B', ...at('oneOf/1') },
        { kind: 'ref', name: 'C', ...at('oneOf/2') },
      ],
      discriminator: {
        property: 'type',
        mapping: new Map([
          ['a', 'A'],
          ['b', 'B'],
          ['C', 'C'],
        ]),
      },
      ...base,
    });
  });

  test('uses ref names as discriminator values when mapping is missing', () => {
    const { ctx } = setup(comps(['A', 'B']));
    const s = parseSchema(
      {
        anyOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
        discriminator: { propertyName: 'kind' },
      },
      ctx,
    );
    expect(s.kind === 'union' && s.discriminator).toEqual({
      property: 'kind',
      mapping: new Map([
        ['A', 'A'],
        ['B', 'B'],
      ]),
    });
  });
});

describe('parseSchema $ref', () => {
  test('maps component refs to ref nodes, keeping description/deprecated siblings', () => {
    const { ctx } = setup(comps(['A']));
    expect(
      parseSchema({ $ref: '#/components/schemas/A', description: 'd', deprecated: true, readOnly: true }, ctx),
    ).toEqual({ kind: 'ref', name: 'A', description: 'd', deprecated: true, readOnly: true, ...base });
  });

  test('treats nullable on a $ref sibling as nullable ref', () => {
    const { ctx } = setup(comps(['A']), '3.0');
    expect(parseSchema({ $ref: '#/components/schemas/A', nullable: true }, ctx)).toEqual({
      kind: 'ref',
      name: 'A',
      ...base,
      nullable: true,
    });
  });

  test('errors broken-ref with JSON pointer for unresolvable $ref', () => {
    const { ctx, diagnostics } = setup(comps(['A']));
    let caught: unknown;
    try {
      parseSchema({ $ref: '#/components/schemas/Missing' }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArchonError);
    expect(caught).toMatchObject({ code: 'broken-ref', pointer: P });
    expect(diagnostics.entries).toMatchObject([{ level: 'error', code: 'broken-ref', pointer: P }]);
  });

  test('inlines refs that do not point at components/schemas', () => {
    const { ctx } = setup({ components: { schemas: {}, parameters: { p: { schema: { type: 'string' } } } } });
    expect(parseSchema({ $ref: '#/components/parameters/p/schema', description: 'd' }, ctx)).toEqual({
      kind: 'string',
      description: 'd',
      nullable: false,
      origin: '#/components/parameters/p/schema',
    });
  });

  test('errors unsupported-ref on circular inline refs', () => {
    const { ctx } = setup({
      components: {
        schemas: {},
        x: { a: { $ref: '#/components/x/b' }, b: { $ref: '#/components/x/a' } },
      },
    });
    expect(() => parseSchema({ $ref: '#/components/x/a' }, ctx)).toThrowError(
      expect.objectContaining({ code: 'unsupported-ref' }),
    );
  });

  test('errors broken-ref when an inline ref target does not exist', () => {
    const { ctx } = setup();
    expect(() => parseSchema({ $ref: '#/components/nope/x' }, ctx)).toThrowError(
      expect.objectContaining({ code: 'broken-ref', pointer: P }),
    );
  });

  test('errors unsupported-ref on non-local refs', () => {
    const { ctx } = setup();
    expect(() => parseSchema({ $ref: 'https://example.com/a.json' }, ctx)).toThrowError(
      expect.objectContaining({ code: 'unsupported-ref', pointer: P }),
    );
  });
});

describe('parseSchema unsupported keywords', () => {
  test('warns unsupported-keyword for not/if', () => {
    const { ctx, diagnostics } = setup();
    parseSchema({ type: 'object', not: { type: 'string' }, if: { type: 'string' }, then: {}, else: {} }, ctx);
    expect(diagnostics.entries.map((e) => [e.level, e.code, e.pointer])).toEqual([
      ['warn', 'unsupported-keyword', P],
      ['warn', 'unsupported-keyword', P],
      ['warn', 'unsupported-keyword', P],
      ['warn', 'unsupported-keyword', P],
    ]);
    expect(diagnostics.entries[0]?.message).toContain('not');
  });

  test('treats a lone not as unknown, and warns for patternProperties', () => {
    const { ctx, diagnostics } = setup();
    expect(parseSchema({ not: { type: 'string' } }, ctx)).toEqual({ kind: 'unknown', ...base });
    parseSchema({ type: 'object', patternProperties: { '^x': { type: 'string' } } }, ctx);
    expect(diagnostics.entries.map((e) => e.message).join('\n')).toContain('patternProperties');
  });
});

describe('detectVersion', () => {
  test('maps the openapi field to 3.0 or 3.1', () => {
    expect(detectVersion({ openapi: '3.0.3' })).toBe('3.0');
    expect(detectVersion({ openapi: '3.1.0' })).toBe('3.1');
    expect(detectVersion({ openapi: '3.1.1-rc.1' })).toBe('3.1');
  });
});

describe('parseComponentSchemas', () => {
  test('handles self-referencing schema without recursion', () => {
    const { ctx, doc } = setup({
      components: {
        schemas: {
          Comment: {
            type: 'object',
            properties: { replies: { type: 'array', items: { $ref: '#/components/schemas/Comment' } } },
          },
          A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
        },
      },
    });
    const out = parseComponentSchemas(doc, ctx);
    expect([...out.keys()]).toEqual(['Comment', 'A', 'B']);
    const comment = out.get('Comment');
    expect(comment).toMatchObject({ kind: 'object', origin: '#/components/schemas/Comment' });
    const replies = comment?.kind === 'object' ? comment.properties[0]?.schema : undefined;
    expect(replies?.kind === 'array' && replies.items).toEqual({
      kind: 'ref',
      name: 'Comment',
      nullable: false,
      origin: '#/components/schemas/Comment/properties/replies/items',
    });
  });

  test('returns an empty map when there are no component schemas', () => {
    const { ctx, doc } = setup();
    expect(parseComponentSchemas(doc, ctx).size).toBe(0);
  });

  test('parses natsuneko fixture schemas without errors', () => {
    const doc = JSON.parse(
      readFileSync(new URL('../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const diagnostics = new Diagnostics();
    const out = parseComponentSchemas(doc, { doc, version: detectVersion(doc), diagnostics, pointer: '#' });
    expect(out.size).toBe(97);
    expect(diagnostics.entries.filter((e) => e.level === 'error')).toEqual([]);
  });
});
