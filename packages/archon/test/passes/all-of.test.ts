import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../../src/ir/types.js';
import { flattenAllOf } from '../../src/passes/all-of.js';

const str: IRSchema = { kind: 'string', nullable: false };
const int: IRSchema = { kind: 'integer', nullable: false };
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const obj = (
  props: Record<string, IRSchema>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
): IRSchema =>
  ({
    kind: 'object',
    nullable: false,
    properties: Object.entries(props).map(([name, schema]) => ({ name, schema, required: required.includes(name) })),
    ...extra,
  }) as IRSchema;
const allOf = (members: IRSchema[], extra: Record<string, unknown> = {}): IRSchema =>
  ({ kind: 'intersection', nullable: false, members, ...extra }) as IRSchema;

function doc(schemas: Record<string, IRSchema>, operations: IROperation[] = []): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations,
  };
}

function op(schema: IRSchema): IROperation {
  return {
    id: 'GET /a',
    name: 'getA',
    method: 'get',
    path: '/a',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: [{ status: 200, headers: new Map(), contents: [{ mediaType: 'application/json', kind: 'json', schema }] }],
    security: [],
  };
}

const props = (s: IRSchema | undefined) =>
  s?.kind === 'object' ? s.properties.map((p) => [p.name, p.schema.kind, p.required]) : undefined;

describe('flattenAllOf', () => {
  it('merges object members and required', () => {
    const ir = doc({
      A: allOf([obj({ id: str, a: str }, ['id']), obj({ b: int, a: int }, ['b'])], { description: 'merged', nullable: true }),
    });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    const a = ir.schemas.get('A');
    expect(a?.kind).toBe('object');
    // 同名プロパティは後勝ち、required は OR
    expect(props(a)).toEqual([
      ['id', 'string', true],
      ['a', 'integer', false],
      ['b', 'integer', true],
    ]);
    // intersection 自身の meta は維持される
    expect(a).toMatchObject({ description: 'merged', nullable: true });
    expect(diagnostics.entries).toEqual([]);
  });

  it('ORs required across members that redefine a property', () => {
    const ir = doc({ A: allOf([obj({ x: str }, ['x']), obj({ x: int }, [])]) });
    flattenAllOf(ir, new Diagnostics());
    expect(props(ir.schemas.get('A'))).toEqual([['x', 'integer', true]]);
  });

  it('uses the last specified additionalProperties', () => {
    const ir = doc({
      A: allOf([
        obj({ a: str }, [], { additionalProperties: str }),
        obj({ b: str }, [], { additionalProperties: int }),
        obj({ c: str }),
      ]),
      B: allOf([obj({ a: str }, [], { additionalProperties: false }), obj({ b: str })]),
      C: allOf([obj({ a: str }), obj({ b: str })]),
    });
    flattenAllOf(ir, new Diagnostics());
    expect((ir.schemas.get('A') as { additionalProperties?: IRSchema }).additionalProperties?.kind).toBe('integer');
    expect((ir.schemas.get('B') as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    expect('additionalProperties' in (ir.schemas.get('C') as object)).toBe(false);
  });

  it('keeps intersection when a member is a primitive', () => {
    const original = allOf([obj({ a: str }), str]);
    const ir = doc({ A: original });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    expect(ir.schemas.get('A')).toEqual(original);
    expect(diagnostics.entries).toEqual([]);
  });

  it('resolves ref members', () => {
    const ir = doc({
      Base: obj({ id: str }, ['id']),
      Alias: ref('Base'),
      Child: allOf([ref('Base'), obj({ name: str }, ['name'])]),
      ViaAlias: allOf([ref('Alias'), obj({ extra: int })]),
      Chain: allOf([ref('Child'), obj({ more: int })]),
    });
    flattenAllOf(ir, new Diagnostics());
    expect(props(ir.schemas.get('Child'))).toEqual([
      ['id', 'string', true],
      ['name', 'string', true],
    ]);
    expect(props(ir.schemas.get('ViaAlias'))).toEqual([
      ['id', 'string', true],
      ['extra', 'integer', false],
    ]);
    // 名前付き intersection への ref もたどれる
    expect(props(ir.schemas.get('Chain'))).toEqual([
      ['id', 'string', true],
      ['name', 'string', true],
      ['more', 'integer', false],
    ]);
    // 参照先は変更されない
    expect(ir.schemas.get('Base')?.kind).toBe('object');
  });

  it('keeps intersection and reports info when a ref member is missing', () => {
    const original = allOf([ref('Nope'), obj({ a: str })], { origin: '#/components/schemas/A' });
    const ir = doc({ A: original });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    expect(ir.schemas.get('A')).toEqual(original);
    expect(diagnostics.entries).toEqual([
      expect.objectContaining({ level: 'info', code: 'allof-not-flattened', pointer: '#/components/schemas/A' }),
    ]);
  });

  it('keeps intersection when a ref member points to a non-object schema', () => {
    const original = allOf([ref('S'), obj({ a: str })]);
    const ir = doc({ S: str, A: original });
    flattenAllOf(ir, new Diagnostics());
    expect(ir.schemas.get('A')).toEqual(original);
  });

  it('terminates on cyclic allOf', () => {
    const ir = doc({
      A: allOf([ref('B'), obj({ a: str })], { origin: '#/components/schemas/A' }),
      B: allOf([ref('A'), obj({ b: str })], { origin: '#/components/schemas/B' }),
      Self: allOf([ref('Self'), obj({ s: str })], { origin: '#/components/schemas/Self' }),
    });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    expect(ir.schemas.get('A')?.kind).toBe('intersection');
    expect(ir.schemas.get('B')?.kind).toBe('intersection');
    expect(ir.schemas.get('Self')?.kind).toBe('intersection');
    expect(diagnostics.entries.map((e) => e.code)).toEqual(['allof-not-flattened', 'allof-not-flattened', 'allof-not-flattened']);
  });

  it('flattens a ref to an object that merely references itself', () => {
    const ir = doc({
      Node: obj({ next: ref('Node') }),
      Ext: allOf([ref('Node'), obj({ v: int })]),
    });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    expect(props(ir.schemas.get('Ext'))).toEqual([
      ['next', 'ref', false],
      ['v', 'integer', false],
    ]);
    expect(diagnostics.entries).toEqual([]);
  });

  it('flattens nested allOf at any depth and in operation schemas', () => {
    const inner = allOf([obj({ a: str }), obj({ b: str })]);
    const ir = doc(
      { Holder: obj({ list: { kind: 'array', nullable: false, items: inner } as IRSchema }) },
      [op(allOf([obj({ x: str }), allOf([obj({ y: str }), obj({ z: str })])]))],
    );
    ir.operations[0]?.parameters.push({
      name: 'q',
      in: 'query',
      required: false,
      deprecated: false,
      schema: inner,
      style: 'form',
      explode: true,
      allowReserved: false,
    });
    ir.operations[0]?.responses[0]?.headers.set('X-H', inner);
    flattenAllOf(ir, new Diagnostics());

    const holder = ir.schemas.get('Holder');
    const list = holder?.kind === 'object' ? holder.properties[0]?.schema : undefined;
    expect(list?.kind === 'array' ? props(list.items) : undefined).toEqual([
      ['a', 'string', false],
      ['b', 'string', false],
    ]);
    const o = ir.operations[0];
    expect(props(o?.responses[0]?.contents[0]?.schema)).toEqual([
      ['x', 'string', false],
      ['y', 'string', false],
      ['z', 'string', false],
    ]);
    expect(props(o?.parameters[0]?.schema)).toHaveLength(2);
    expect(props(o?.responses[0]?.headers.get('X-H'))).toHaveLength(2);
  });

  it('flattens nested allOf copied from a ref target declared after the referrer', () => {
    const inner = allOf([obj({ a: str }), obj({ b: str })]);
    const ir = doc({
      Child: allOf([ref('Base'), obj({ z: str })]),
      Base: obj({ list: { kind: 'array', nullable: false, items: inner } as IRSchema }),
    });
    flattenAllOf(ir, new Diagnostics());
    for (const name of ['Child', 'Base']) {
      const schema = ir.schemas.get(name);
      const list = schema?.kind === 'object' ? schema.properties.find((p) => p.name === 'list')?.schema : undefined;
      expect(list?.kind === 'array' ? list.items.kind : undefined).toBe('object');
    }
  });

  it('terminates on a self-referencing allOf inside the target object (property)', () => {
    // Node.next = allOf[$ref Node]: 展開すると無限に続くので intersection のまま残す。
    const next = allOf([ref('Node')], { origin: '#/components/schemas/Node/properties/next' });
    const ir = doc({ Node: obj({ next }) });
    const diagnostics = new Diagnostics();
    expect(() => flattenAllOf(ir, diagnostics)).not.toThrow();
    const node = ir.schemas.get('Node');
    expect(node?.kind === 'object' ? node.properties[0]?.schema.kind : undefined).toBe('intersection');
    expect(diagnostics.entries.map((e) => e.code)).toEqual(['allof-not-flattened']);
  });

  it('terminates on a self-referencing allOf inside the target object (array items)', () => {
    const items = allOf([ref('Tree')], { origin: '#/components/schemas/Tree/properties/children/items' });
    const ir = doc({
      Tree: obj({ children: { kind: 'array', nullable: false, items } as IRSchema }),
      Ext: allOf([ref('Tree'), obj({ v: int })], { origin: '#/components/schemas/Ext' }),
    });
    const diagnostics = new Diagnostics();
    expect(() => flattenAllOf(ir, diagnostics)).not.toThrow();
    const tree = ir.schemas.get('Tree');
    const children = tree?.kind === 'object' ? tree.properties[0]?.schema : undefined;
    expect(children?.kind === 'array' ? children.items.kind : undefined).toBe('intersection');
    // Ext は Tree のコピーに循環する allOf を含むので、そのまま残す
    expect(ir.schemas.get('Ext')?.kind).toBe('intersection');
  });

  it('reports each unflattened intersection origin only once', () => {
    const missing = allOf([ref('Nope')], { origin: '#/components/schemas/Base/properties/x' });
    const ir = doc({
      Base: obj({ x: missing }),
      A: allOf([ref('Base'), obj({ a: str })], { origin: '#/components/schemas/A' }),
      B: allOf([ref('Base'), obj({ b: str })], { origin: '#/components/schemas/B' }),
    });
    const diagnostics = new Diagnostics();
    flattenAllOf(ir, diagnostics);
    const pointers = diagnostics.entries.map((e) => e.pointer);
    expect(pointers.filter((p) => p === '#/components/schemas/Base/properties/x')).toHaveLength(1);
    expect(new Set(pointers).size).toBe(pointers.length);
  });
});
