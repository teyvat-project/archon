import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../../src/ir/types.js';
import { applyFilters, matchesPattern, removeOrphans, renameSchemas } from '../../src/passes/filters.js';

const str: IRSchema = { kind: 'string', nullable: false };
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const obj = (props: Record<string, IRSchema>, extra: Partial<IRSchema> = {}): IRSchema =>
  ({
    kind: 'object',
    nullable: false,
    properties: Object.entries(props).map(([name, schema]) => ({ name, schema, required: true })),
    ...extra,
  }) as IRSchema;

function op(method: IROperation['method'], path: string, extra: Partial<IROperation> = {}): IROperation {
  return {
    id: `${method.toUpperCase()} ${path}`,
    name: `${method}${path}`,
    method,
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    ...extra,
  };
}

function doc(operations: IROperation[], schemas: Record<string, IRSchema> = {}): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations,
  };
}

const ids = (ir: IRDocument) => ir.operations.map((o) => o.id);

function jsonResponse(schema: IRSchema): IROperation['responses'] {
  return [
    {
      status: 200,
      headers: new Map(),
      contents: [{ mediaType: 'application/json', kind: 'json', schema }],
    },
  ];
}

describe('matchesPattern', () => {
  it('matches exact strings and /regex/flags', () => {
    expect(matchesPattern('GET /a', 'GET /a')).toBe(true);
    expect(matchesPattern('GET /ab', 'GET /a')).toBe(false);
    expect(matchesPattern('GET /a/b', '/^GET \\/a/')).toBe(true);
    expect(matchesPattern('get /a', '/^GET/i')).toBe(true);
    expect(matchesPattern('get /a', '/^GET/')).toBe(false);
  });
});

describe('applyFilters', () => {
  it('include regex and exclude exact (exclude wins)', () => {
    const ir = doc([op('get', '/a'), op('get', '/b'), op('post', '/a'), op('get', '/c')]);
    applyFilters(ir, {
      operations: { include: ['/^GET /'], exclude: ['GET /b'] },
      preserveOrder: true,
    });
    expect(ids(ir)).toEqual(['GET /a', 'GET /c']);
  });

  it('exclude wins when include also matches', () => {
    const ir = doc([op('get', '/a')]);
    applyFilters(ir, { operations: { include: ['GET /a'], exclude: ['/a$/'] } });
    expect(ids(ir)).toEqual([]);
  });

  it('tag filter', () => {
    const mk = () =>
      doc([
        op('get', '/a', { tags: ['pets'] }),
        op('get', '/b', { tags: ['admin', 'pets'] }),
        op('get', '/c', { tags: ['users'] }),
        op('get', '/d'),
      ]);

    const include = mk();
    applyFilters(include, { tags: { include: ['pets'] } });
    expect(ids(include)).toEqual(['GET /a', 'GET /b']);

    const exclude = mk();
    applyFilters(exclude, { tags: { exclude: ['/^adm/'] } });
    expect(ids(exclude)).toEqual(['GET /a', 'GET /c', 'GET /d']);

    const both = mk();
    applyFilters(both, { tags: { include: ['pets'], exclude: ['admin'] } });
    expect(ids(both)).toEqual(['GET /a']);
  });

  it('filters named schemas without rewriting refs', () => {
    const ir = doc([op('get', '/a', { responses: jsonResponse(ref('Gone')) })], { Keep: str, Gone: str, Tmp: str });
    applyFilters(ir, { schemas: { include: ['/^(Keep|Gone)$/'], exclude: ['Gone'] } });
    expect([...ir.schemas.keys()]).toEqual(['Keep']);
    expect(ir.operations[0]?.responses[0]?.contents[0]?.schema).toEqual(ref('Gone'));
  });

  it('deprecated false removes deprecated operations and schemas', () => {
    const ir = doc([op('get', '/a'), op('get', '/old', { deprecated: true })], {
      Fresh: str,
      Stale: { ...str, deprecated: true },
    });
    applyFilters(ir, { deprecated: false });
    expect(ids(ir)).toEqual(['GET /a']);
    expect([...ir.schemas.keys()]).toEqual(['Fresh']);

    const keep = doc([op('get', '/old', { deprecated: true })], { Stale: { ...str, deprecated: true } });
    applyFilters(keep, { deprecated: true });
    expect(ids(keep)).toEqual(['GET /old']);
    expect([...keep.schemas.keys()]).toEqual(['Stale']);
  });

  it('sorts by id unless preserveOrder', () => {
    const mk = () => doc([op('get', '/b'), op('get', '/a'), op('delete', '/z')], { B: str, A: str });

    const sorted = mk();
    applyFilters(sorted, undefined);
    expect(ids(sorted)).toEqual(['DELETE /z', 'GET /a', 'GET /b']);
    expect([...sorted.schemas.keys()]).toEqual(['A', 'B']);

    const kept = mk();
    applyFilters(kept, { preserveOrder: true });
    expect(ids(kept)).toEqual(['GET /b', 'GET /a', 'DELETE /z']);
    expect([...kept.schemas.keys()]).toEqual(['B', 'A']);
  });
});

describe('removeOrphans', () => {
  it('removes unreachable schemas but keeps transitive refs', () => {
    const ir = doc(
      [
        op('get', '/a', {
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              deprecated: false,
              schema: ref('Param'),
              style: 'form',
              explode: true,
              allowReserved: false,
            },
          ],
          responses: jsonResponse({ kind: 'array', nullable: false, items: ref('Top') }),
        }),
      ],
      {
        Top: obj({ child: ref('Mid') }),
        Mid: obj({ leaf: ref('Leaf') }),
        Leaf: str,
        Param: str,
        Lonely: obj({ other: ref('AlsoLonely') }),
        AlsoLonely: str,
      },
    );
    removeOrphans(ir);
    expect([...ir.schemas.keys()].sort()).toEqual(['Leaf', 'Mid', 'Param', 'Top']);
  });

  it('terminates on cyclic refs', () => {
    const ir = doc([op('get', '/a', { responses: jsonResponse(ref('A')) })], {
      A: obj({ b: ref('B') }),
      B: obj({ a: ref('A') }),
    });
    removeOrphans(ir);
    expect([...ir.schemas.keys()].sort()).toEqual(['A', 'B']);
  });

  it('treats discriminator mapping values as references', () => {
    const union: IRSchema = {
      kind: 'union',
      nullable: false,
      variants: [ref('Cat')],
      discriminator: {
        property: 'type',
        mapping: new Map([
          ['cat', 'Cat'],
          ['dog', 'Dog'],
        ]),
      },
    };
    const ir = doc([op('get', '/pets', { responses: jsonResponse(union) })], {
      Cat: obj({ meow: str }),
      Dog: obj({ bark: ref('Bone') }),
      Bone: str,
      Unused: str,
    });
    removeOrphans(ir);
    expect([...ir.schemas.keys()].sort()).toEqual(['Bone', 'Cat', 'Dog']);
  });
});

describe('renameSchemas', () => {
  it('applies template and rewrites refs', () => {
    const header: IRSchema = ref('Id');
    const ir = doc(
      [
        op('post', '/a', {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              deprecated: false,
              schema: ref('Id'),
              style: 'simple',
              explode: false,
              allowReserved: false,
            },
          ],
          requestBody: {
            required: true,
            contents: [{ mediaType: 'application/json', kind: 'json', schema: ref('Pet') }],
          },
          responses: [
            {
              status: 200,
              headers: new Map([['X-Id', header]]),
              contents: [
                {
                  mediaType: 'application/json',
                  kind: 'json',
                  schema: { kind: 'array', nullable: false, items: ref('Pet') },
                },
              ],
            },
          ],
        }),
      ],
      { Id: str, Pet: obj({ id: ref('Id'), friends: { kind: 'array', nullable: false, items: ref('Pet') } }) },
    );
    const diagnostics = new Diagnostics();
    renameSchemas(ir, '{{name}}Model', diagnostics);

    expect([...ir.schemas.keys()]).toEqual(['IdModel', 'PetModel']);
    const pet = ir.schemas.get('PetModel') as Extract<IRSchema, { kind: 'object' }>;
    expect(pet.properties[0]?.schema).toEqual(ref('IdModel'));
    expect(pet.properties[1]?.schema).toEqual({ kind: 'array', nullable: false, items: ref('PetModel') });

    const o = ir.operations[0] as IROperation;
    expect(o.parameters[0]?.schema).toEqual(ref('IdModel'));
    expect(o.requestBody?.contents[0]?.schema).toEqual(ref('PetModel'));
    expect(o.responses[0]?.headers.get('X-Id')).toEqual(ref('IdModel'));
    expect(o.responses[0]?.contents[0]?.schema).toEqual({
      kind: 'array',
      nullable: false,
      items: ref('PetModel'),
    });
    expect(diagnostics.entries).toEqual([]);
  });

  it('accepts a function', () => {
    const ir = doc([], { pet: str });
    renameSchemas(ir, (n) => n.toUpperCase(), new Diagnostics());
    expect([...ir.schemas.keys()]).toEqual(['PET']);
  });

  it('skips conflicting rename with warning', () => {
    const ir = doc([op('get', '/a', { responses: jsonResponse(ref('Pet')) })], { Pet: str, PetDto: str });
    const diagnostics = new Diagnostics();
    renameSchemas(ir, (n) => (n === 'Pet' ? 'PetDto' : n), diagnostics);

    expect([...ir.schemas.keys()]).toEqual(['Pet', 'PetDto']);
    expect(ir.operations[0]?.responses[0]?.contents[0]?.schema).toEqual(ref('Pet'));
    expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]).toMatchObject({ level: 'warn', code: 'schema-rename-conflict' });
  });

  it('is a no-op without schemaName', () => {
    const ir = doc([], { Pet: str });
    renameSchemas(ir, undefined, new Diagnostics());
    expect([...ir.schemas.keys()]).toEqual(['Pet']);
  });

  it('rewrites discriminator mapping values', () => {
    const union: IRSchema = {
      kind: 'union',
      nullable: false,
      variants: [ref('Cat'), ref('Dog')],
      discriminator: {
        property: 'type',
        mapping: new Map([
          ['cat', 'Cat'],
          ['dog', 'Dog'],
        ]),
      },
    };
    const ir = doc([op('get', '/pets', { responses: jsonResponse(union) })], {
      Cat: obj({ kind: str }),
      Dog: obj({ kind: str }),
      Owner: obj({ pet: union }),
    });
    renameSchemas(ir, 'Api{{name}}', new Diagnostics());

    const expected = new Map([
      ['cat', 'ApiCat'],
      ['dog', 'ApiDog'],
    ]);
    const inOp = ir.operations[0]?.responses[0]?.contents[0]?.schema as Extract<IRSchema, { kind: 'union' }>;
    expect(inOp.discriminator?.mapping).toEqual(expected);
    expect(inOp.variants).toEqual([ref('ApiCat'), ref('ApiDog')]);

    const owner = ir.schemas.get('ApiOwner') as Extract<IRSchema, { kind: 'object' }>;
    const nested = owner.properties[0]?.schema as Extract<IRSchema, { kind: 'union' }>;
    expect(nested.discriminator?.mapping).toEqual(expected);
  });
});
