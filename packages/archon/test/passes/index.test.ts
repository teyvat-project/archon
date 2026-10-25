import { describe, expect, it, vi } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IRSchema } from '../../src/ir/types.js';
import { runCommonPasses, runPluginPasses } from '../../src/passes/index.js';

// 実装は呼び出し順だけ記録して本物にそのまま委譲する（production code を DI 化しない）。
const calls = vi.hoisted(() => [] as string[]);

vi.mock('../../src/passes/filters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/passes/filters.js')>();
  return {
    ...actual,
    applyFilters: vi.fn((...args: Parameters<typeof actual.applyFilters>) => {
      calls.push('applyFilters');
      return actual.applyFilters(...args);
    }),
    renameSchemas: vi.fn((...args: Parameters<typeof actual.renameSchemas>) => {
      calls.push('renameSchemas');
      return actual.renameSchemas(...args);
    }),
    removeOrphans: vi.fn((...args: Parameters<typeof actual.removeOrphans>) => {
      calls.push('removeOrphans');
      return actual.removeOrphans(...args);
    }),
  };
});
vi.mock('../../src/passes/all-of.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/passes/all-of.js')>();
  return {
    ...actual,
    flattenAllOf: vi.fn((...args: Parameters<typeof actual.flattenAllOf>) => {
      calls.push('flattenAllOf');
      return actual.flattenAllOf(...args);
    }),
  };
});
vi.mock('../../src/passes/discriminator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/passes/discriminator.js')>();
  return {
    ...actual,
    inferDiscriminators: vi.fn((...args: Parameters<typeof actual.inferDiscriminators>) => {
      calls.push('inferDiscriminators');
      return actual.inferDiscriminators(...args);
    }),
  };
});
vi.mock('../../src/passes/hoist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/passes/hoist.js')>();
  return {
    ...actual,
    hoistInlineSchemas: vi.fn((...args: Parameters<typeof actual.hoistInlineSchemas>) => {
      calls.push('hoistInlineSchemas');
      return actual.hoistInlineSchemas(...args);
    }),
  };
});
vi.mock('../../src/passes/read-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/passes/read-write.js')>();
  return {
    ...actual,
    splitReadWrite: vi.fn((...args: Parameters<typeof actual.splitReadWrite>) => {
      calls.push('splitReadWrite');
      return actual.splitReadWrite(...args);
    }),
  };
});

const str: IRSchema = { kind: 'string', nullable: false };
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const obj = (props: Record<string, IRSchema>): IRSchema => ({
  kind: 'object',
  nullable: false,
  properties: Object.entries(props).map(([name, schema]) => ({ name, schema, required: true })),
});
const statusEnum: IRSchema = { kind: 'enum', nullable: false, base: 'string', values: ['a', 'b'] };

function doc(schemas: Record<string, IRSchema>): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations: [
      {
        id: 'GET /pets',
        name: 'getPets',
        method: 'get',
        path: '/pets',
        tags: [],
        deprecated: false,
        parameters: [],
        responses: [
          {
            status: 200,
            headers: new Map(),
            contents: [{ mediaType: 'application/json', kind: 'json', schema: ref('Pet') }],
          },
        ],
        security: [],
      },
    ],
  };
}

describe('runCommonPasses', () => {
  it('executes in documented order', () => {
    calls.length = 0;
    const ir = doc({ Pet: obj({ status: statusEnum }) });
    runCommonPasses(
      ir,
      {
        filters: { orphans: false },
        transforms: { enums: 'root', readWrite: {}, schemaName: '{{name}}Model' },
      },
      new Diagnostics(),
    );
    expect(calls).toEqual([
      'applyFilters',
      'flattenAllOf',
      'inferDiscriminators',
      'hoistInlineSchemas',
      'splitReadWrite',
      'renameSchemas',
      'removeOrphans',
    ]);
  });

  it('skips optional passes by default', () => {
    calls.length = 0;
    runCommonPasses(doc({ Pet: obj({ id: str }) }), {}, new Diagnostics());
    expect(calls).toEqual(['applyFilters', 'flattenAllOf', 'inferDiscriminators', 'renameSchemas']);
  });

  it('skips discriminator inference when disabled', () => {
    calls.length = 0;
    runCommonPasses(doc({ Pet: obj({ id: str }) }), { transforms: { inferDiscriminator: false } }, new Diagnostics());
    expect(calls).not.toContain('inferDiscriminators');
  });

  it('hoists only enums, using inlineSchemaName, when enums is root', () => {
    const ir = doc({ Pet: obj({ status: statusEnum, owner: obj({ name: str }) }) });
    runCommonPasses(
      ir,
      { transforms: { enums: 'root' }, inlineSchemaName: (_path, { suggested }) => `X${suggested}` },
      new Diagnostics(),
    );
    expect([...ir.schemas.keys()]).toEqual(['Pet', 'XPetStatus']);
    const pet = ir.schemas.get('Pet');
    const owner = pet?.kind === 'object' ? pet.properties.find((p) => p.name === 'owner')?.schema : undefined;
    expect(owner?.kind).toBe('object');
  });

  it('removes orphans only when filters.orphans is false', () => {
    const keep = doc({ Pet: obj({ id: str }), Unused: obj({ x: str }) });
    runCommonPasses(keep, {}, new Diagnostics());
    expect(keep.schemas.has('Unused')).toBe(true);

    const drop = doc({ Pet: obj({ id: str }), Unused: obj({ x: str }) });
    runCommonPasses(drop, { filters: { orphans: false } }, new Diagnostics());
    expect([...drop.schemas.keys()]).toEqual(['Pet']);
  });
});

describe('runPluginPasses', () => {
  it('does not mutate original IR', () => {
    const ir = doc({ Pet: obj({ status: statusEnum, owner: obj({ name: str }) }) });
    const before = structuredClone(ir);
    const out = runPluginPasses(ir, { hoistInlineObjects: true, hoistInlineEnums: true });

    expect(ir).toEqual(before);
    expect(out).not.toBe(ir);
    expect([...out.schemas.keys()]).toEqual(['Pet', 'PetStatus', 'PetOwner']);
  });

  it('returns an unchanged copy when no hoisting is requested', () => {
    const ir = doc({ Pet: obj({ owner: obj({ name: str }) }) });
    const out = runPluginPasses(ir, {});
    expect(out).toEqual(ir);
    expect(out).not.toBe(ir);
  });

  it('passes hoistInlineUnions through', () => {
    const ir = doc({ Pet: obj({ either: { kind: 'union', nullable: false, variants: [str, obj({ a: str })] } as IRSchema }) });
    const out = runPluginPasses(ir, { hoistInlineUnions: true });
    expect([...out.schemas.keys()]).toEqual(['Pet', 'PetEither']);
  });

  it('passes the name hook through', () => {
    const ir = doc({ Pet: obj({ owner: obj({ name: str }) }) });
    const out = runPluginPasses(ir, { hoistInlineObjects: true }, (_path, { suggested }) => `Custom${suggested}`);
    expect([...out.schemas.keys()]).toEqual(['Pet', 'CustomPetOwner']);
  });
});
