import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IROperation, IRSchema } from '../../src/ir/types.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import { parseDocument } from '../../src/parser/index.js';
import { inferDiscriminators } from '../../src/passes/discriminator.js';

const str: IRSchema = { kind: 'string', nullable: false };
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const tag = (...values: string[]): IRSchema => ({ kind: 'enum', nullable: false, base: 'string', values });
const constant = (value: unknown): IRSchema => ({ kind: 'const', nullable: false, value });
const obj = (props: Record<string, IRSchema>, required: string[] = Object.keys(props), extra: Record<string, unknown> = {}): IRSchema =>
  ({
    kind: 'object',
    nullable: false,
    properties: Object.entries(props).map(([name, schema]) => ({ name, schema, required: required.includes(name) })),
    ...extra,
  }) as IRSchema;
const union = (variants: IRSchema[], extra: Record<string, unknown> = {}): IRSchema =>
  ({ kind: 'union', nullable: false, variants, ...extra }) as IRSchema;

function doc(schemas: Record<string, IRSchema>, operations: IROperation[] = []): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations,
  };
}

const disc = (s: IRSchema | undefined) => (s?.kind === 'union' ? s.discriminator : undefined);

describe('inferDiscriminators', () => {
  it('infers discriminator from single-value enum property', () => {
    // natsuneko の profileEmoji: { type: enum['standard'] } | { type: enum['custom'] }
    const ir = doc({
      Emoji: union([
        obj({ type: tag('standard'), value: str }),
        obj({ type: tag('custom'), customReactionId: str }),
      ]),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('Emoji'))).toEqual({
      property: 'type',
      mapping: new Map([
        ['standard', ''],
        ['custom', ''],
      ]),
    });
  });

  it('infers from const string and maps ref variants to their names', () => {
    const ir = doc({
      Cat: obj({ kind: constant('cat'), meow: str }),
      Dog: obj({ kind: constant('dog'), bark: str }),
      Pet: union([ref('Cat'), ref('Dog')]),
      Mixed: union([ref('Cat'), obj({ kind: constant('bird') })]),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('Pet'))).toEqual({
      property: 'kind',
      mapping: new Map([
        ['cat', 'Cat'],
        ['dog', 'Dog'],
      ]),
    });
    expect(disc(ir.schemas.get('Mixed'))?.mapping).toEqual(
      new Map([
        ['cat', 'Cat'],
        ['bird', ''],
      ]),
    );
  });

  it('follows ref aliases but maps to the variant ref name', () => {
    const ir = doc({
      Cat: obj({ kind: constant('cat') }),
      CatAlias: ref('Cat'),
      Dog: obj({ kind: constant('dog') }),
      Pet: union([ref('CatAlias'), ref('Dog')]),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('Pet'))?.mapping).toEqual(
      new Map([
        ['cat', 'CatAlias'],
        ['dog', 'Dog'],
      ]),
    );
  });

  it('picks the first declared candidate property', () => {
    const ir = doc({
      U: union([
        obj({ id: str, a: tag('x'), b: tag('p') }),
        obj({ id: str, b: tag('q'), a: tag('y') }),
      ]),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('U'))?.property).toBe('a');
  });

  it('does not infer when values collide or property is optional', () => {
    const ir = doc({
      Collide: union([obj({ type: tag('a') }), obj({ type: tag('a'), x: str })]),
      Optional: union([obj({ type: tag('a') }), obj({ type: tag('b') }, [])]),
      MultiEnum: union([obj({ type: tag('a', 'b') }), obj({ type: tag('c') })]),
      Missing: union([obj({ type: tag('a') }), obj({ other: tag('b') })]),
      NonString: union([obj({ type: constant(1) }), obj({ type: constant(2) })]),
      NotObject: union([obj({ type: tag('a') }), str]),
      Single: union([obj({ type: tag('a') })]),
    });
    inferDiscriminators(ir);
    for (const name of ir.schemas.keys()) expect(disc(ir.schemas.get(name))).toBeUndefined();
  });

  it('skips nullable variants', () => {
    const nullable = { ...obj({ type: tag('b') }), nullable: true } as IRSchema;
    const ir = doc({
      N: union([obj({ type: tag('a') }), nullable]),
      Target: { ...obj({ type: tag('b') }), nullable: true } as IRSchema,
      ViaRef: union([obj({ type: tag('a') }), ref('Target')]),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('N'))).toBeUndefined();
    expect(disc(ir.schemas.get('ViaRef'))).toBeUndefined();
  });

  it('does not touch unions that already have a discriminator', () => {
    const existing = { property: 'kind', mapping: new Map([['c', 'Cat']]) };
    const ir = doc({
      Cat: obj({ type: tag('cat'), kind: tag('c') }),
      Dog: obj({ type: tag('dog'), kind: tag('d') }),
      Pet: union([ref('Cat'), ref('Dog')], { discriminator: existing }),
    });
    inferDiscriminators(ir);
    expect(disc(ir.schemas.get('Pet'))).toBe(existing);
  });

  it('handles unresolvable and cyclic refs without throwing', () => {
    const ir = doc({
      A: ref('B'),
      B: ref('A'),
      U: union([ref('A'), ref('Missing')]),
    });
    expect(() => inferDiscriminators(ir)).not.toThrow();
    expect(disc(ir.schemas.get('U'))).toBeUndefined();
  });

  it('infers in nested positions and operation schemas', () => {
    const inner = union([obj({ t: tag('a') }), obj({ t: tag('b') })]);
    const o: IROperation = {
      id: 'GET /a',
      name: 'getA',
      method: 'get',
      path: '/a',
      tags: [],
      deprecated: false,
      parameters: [],
      requestBody: { required: true, contents: [{ mediaType: 'application/json', kind: 'json', schema: obj({ list: { kind: 'array', nullable: false, items: inner } as IRSchema }) }] },
      responses: [{ status: 200, headers: new Map(), contents: [{ mediaType: 'application/json', kind: 'json', schema: inner }] }],
      security: [],
    };
    const ir = doc({ Holder: obj({ item: inner }) }, [o]);
    inferDiscriminators(ir);

    const holder = ir.schemas.get('Holder');
    expect(disc(holder?.kind === 'object' ? holder.properties[0]?.schema : undefined)?.property).toBe('t');
    expect(disc(o.responses[0]?.contents[0]?.schema)?.property).toBe('t');
    const body = o.requestBody?.contents[0]?.schema;
    const list = body?.kind === 'object' ? body.properties[0]?.schema : undefined;
    expect(disc(list?.kind === 'array' ? list.items : undefined)?.property).toBe('t');
  });

  it('infers a discriminator for natsuneko User.profileEmoji (standard / custom)', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const ir = parseDocument(raw, { diagnostics: new Diagnostics() });
    inferDiscriminators(ir);

    const user = ir.schemas.get('User');
    expect(user?.kind).toBe('object');
    const emoji = user?.kind === 'object' ? user.properties.find((p) => p.name === 'profileEmoji')?.schema : undefined;
    expect(emoji?.kind).toBe('union');
    expect(disc(emoji)).toEqual({
      property: 'type',
      mapping: new Map([
        ['standard', ''],
        ['custom', ''],
      ]),
    });
  });
});
