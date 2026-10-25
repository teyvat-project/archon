import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IRMediaType, IROperation, IRSchema } from '../../src/ir/types.js';
import { splitReadWrite } from '../../src/passes/read-write.js';

const str: IRSchema = { kind: 'string', nullable: false };
const ref = (name: string, extra: Record<string, unknown> = {}): IRSchema =>
  ({ kind: 'ref', name, nullable: false, ...extra }) as IRSchema;
const arr = (items: IRSchema): IRSchema => ({ kind: 'array', nullable: false, items });
const obj = (
  props: Record<string, IRSchema>,
  required: string[] = Object.keys(props),
  extra: Record<string, unknown> = {},
): IRSchema =>
  ({
    kind: 'object',
    nullable: false,
    properties: Object.entries(props).map(([name, schema]) => ({ name, schema, required: required.includes(name) })),
    ...extra,
  }) as IRSchema;
const readOnly = (s: IRSchema): IRSchema => ({ ...s, readOnly: true });
const writeOnly = (s: IRSchema): IRSchema => ({ ...s, writeOnly: true });
const json = (schema: IRSchema): IRMediaType => ({ mediaType: 'application/json', kind: 'json', schema });

function op(name: string, extra: Partial<IROperation> = {}): IROperation {
  return {
    id: `GET /${name}`,
    name,
    method: 'get',
    path: `/${name}`,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    ...extra,
  };
}

/** POST body = `reqRef`, 200 response = `resRef`。 */
function roundTrip(reqRef: IRSchema, resRef: IRSchema = reqRef): IROperation {
  return op('items', {
    requestBody: { required: true, contents: [json(reqRef)] },
    responses: [{ status: 200, headers: new Map(), contents: [json(resRef)] }],
  });
}

function doc(schemas: Record<string, IRSchema>, operations: IROperation[] = []): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(Object.entries(schemas)),
    operations,
  };
}

const propNames = (s: IRSchema | undefined): string[] =>
  s?.kind === 'object' ? s.properties.map((p) => p.name) : [];
const prop = (s: IRSchema | undefined, name: string): IRSchema | undefined =>
  s?.kind === 'object' ? s.properties.find((p) => p.name === name)?.schema : undefined;
const requestSchema = (ir: IRDocument): IRSchema | undefined => ir.operations[0]?.requestBody?.contents[0]?.schema;
const responseSchema = (ir: IRDocument): IRSchema | undefined => ir.operations[0]?.responses[0]?.contents[0]?.schema;

describe('splitReadWrite', () => {
  it('splits schema with readOnly id into Writable variant used by request body', () => {
    const ir = doc(
      { Pet: obj({ id: readOnly(str), name: str, secret: writeOnly(str) }, ['id', 'name']) },
      [roundTrip(ref('Pet'))],
    );
    splitReadWrite(ir, {}, new Diagnostics());

    expect([...ir.schemas.keys()]).toEqual(['Pet', 'PetWritable']);
    // request 用: readOnly を除く
    expect(propNames(ir.schemas.get('PetWritable'))).toEqual(['name', 'secret']);
    // response 用: writeOnly を除く（元の名前のまま）
    expect(propNames(ir.schemas.get('Pet'))).toEqual(['id', 'name']);
    expect(requestSchema(ir)).toEqual(ref('PetWritable'));
    expect(responseSchema(ir)).toEqual(ref('Pet'));
  });

  it('applies custom templates for both sides', () => {
    const ir = doc({ Pet: obj({ id: readOnly(str), name: str }) }, [roundTrip(ref('Pet'))]);
    splitReadWrite(ir, { requests: 'New{{name}}', responses: '{{name}}Dto' }, new Diagnostics());

    expect([...ir.schemas.keys()].sort()).toEqual(['NewPet', 'PetDto']);
    expect(requestSchema(ir)).toEqual(ref('NewPet'));
    expect(responseSchema(ir)).toEqual(ref('PetDto'));
  });

  it('does nothing when disabled', () => {
    const ir = doc({ Pet: obj({ id: readOnly(str) }) }, [roundTrip(ref('Pet'))]);
    const before = structuredClone(ir);
    splitReadWrite(ir, false, new Diagnostics());
    expect(ir).toEqual(before);
  });

  it('leaves schemas without readOnly/writeOnly untouched', () => {
    const ir = doc({ Tag: obj({ label: str }), Pet: obj({ id: readOnly(str), tag: ref('Tag') }) }, [
      roundTrip(ref('Pet'), ref('Tag')),
    ]);
    const tag = structuredClone(ir.schemas.get('Tag'));
    splitReadWrite(ir, {}, new Diagnostics());

    expect(ir.schemas.get('Tag')).toEqual(tag);
    expect(ir.schemas.has('TagWritable')).toBe(false);
    // Tag への参照は両側とも元のまま
    expect(prop(ir.schemas.get('PetWritable'), 'tag')).toEqual(ref('Tag'));
    expect(responseSchema(ir)).toEqual(ref('Tag'));
  });

  it('propagates split to schemas referencing split schema', () => {
    const ir = doc(
      {
        Owner: obj({ pet: ref('Pet'), pets: arr(ref('Pet')), note: str }),
        Pet: obj({ id: readOnly(str), name: str }),
        Plain: obj({ x: str }),
      },
      [roundTrip(ref('Owner'))],
    );
    splitReadWrite(ir, {}, new Diagnostics());

    expect([...ir.schemas.keys()].sort()).toEqual(['Owner', 'OwnerWritable', 'Pet', 'PetWritable', 'Plain']);
    const ownerWritable = ir.schemas.get('OwnerWritable');
    expect(prop(ownerWritable, 'pet')).toEqual(ref('PetWritable'));
    expect(prop(ownerWritable, 'pets')).toEqual(arr(ref('PetWritable')));
    const owner = ir.schemas.get('Owner');
    expect(prop(owner, 'pet')).toEqual(ref('Pet'));
    expect(prop(owner, 'pets')).toEqual(arr(ref('Pet')));
    expect(requestSchema(ir)).toEqual(ref('OwnerWritable'));
    expect(responseSchema(ir)).toEqual(ref('Owner'));
  });

  it('keeps readOnly metadata of usage refs out of request variants', () => {
    const ir = doc(
      {
        Owner: obj({ pet: readOnly(ref('Pet')), mine: ref('Pet') }),
        Pet: obj({ id: readOnly(str), name: str }),
      },
      [roundTrip(ref('Owner'))],
    );
    splitReadWrite(ir, {}, new Diagnostics());

    expect(propNames(ir.schemas.get('OwnerWritable'))).toEqual(['mine']);
    expect(propNames(ir.schemas.get('Owner'))).toEqual(['pet', 'mine']);
  });

  it('terminates on cyclic schemas with readOnly', () => {
    const ir = doc(
      {
        Comment: obj({ id: readOnly(str), text: str, replies: arr(ref('Comment')) }),
        A: obj({ b: ref('B') }),
        B: obj({ a: ref('A'), id: readOnly(str) }),
      },
      [roundTrip(ref('Comment')), op('ab', { requestBody: { required: true, contents: [json(ref('A'))] } })],
    );
    splitReadWrite(ir, {}, new Diagnostics());

    expect([...ir.schemas.keys()].sort()).toEqual(['A', 'AWritable', 'B', 'BWritable', 'Comment', 'CommentWritable']);
    expect(prop(ir.schemas.get('CommentWritable'), 'replies')).toEqual(arr(ref('CommentWritable')));
    expect(prop(ir.schemas.get('Comment'), 'replies')).toEqual(arr(ref('Comment')));
    expect(prop(ir.schemas.get('AWritable'), 'b')).toEqual(ref('BWritable'));
    expect(prop(ir.schemas.get('BWritable'), 'a')).toEqual(ref('AWritable'));
    expect(prop(ir.schemas.get('A'), 'b')).toEqual(ref('B'));
    expect(ir.operations[1]?.requestBody?.contents[0]?.schema).toEqual(ref('AWritable'));
  });

  it('uses Writable variants for parameters and plain variants for response headers', () => {
    const ir = doc({ Pet: obj({ id: readOnly(str) }) }, [
      op('items', {
        parameters: [
          {
            name: 'filter',
            in: 'query',
            required: false,
            deprecated: false,
            schema: ref('Pet'),
            style: 'form',
            explode: true,
            allowReserved: false,
          },
        ],
        responses: [{ status: 200, headers: new Map([['X-Pet', ref('Pet')]]), contents: [] }],
      }),
    ]);
    splitReadWrite(ir, {}, new Diagnostics());

    expect(ir.operations[0]?.parameters[0]?.schema).toEqual(ref('PetWritable'));
    expect(ir.operations[0]?.responses[0]?.headers.get('X-Pet')).toEqual(ref('Pet'));
  });

  it('rewrites discriminator mapping values to the matching variant names', () => {
    const union: IRSchema = {
      kind: 'union',
      nullable: false,
      variants: [ref('Cat'), ref('Dog')],
      discriminator: {
        property: 'kind',
        mapping: new Map([
          ['cat', 'Cat'],
          ['dog', 'Dog'],
        ]),
      },
    };
    const ir = doc(
      {
        Animal: union,
        Cat: obj({ kind: str, id: readOnly(str) }),
        Dog: obj({ kind: str }),
      },
      [roundTrip(ref('Animal'))],
    );
    splitReadWrite(ir, {}, new Diagnostics());

    const writable = ir.schemas.get('AnimalWritable');
    expect(writable?.kind === 'union' && writable.variants).toEqual([ref('CatWritable'), ref('Dog')]);
    expect(writable?.kind === 'union' && [...(writable.discriminator?.mapping ?? [])]).toEqual([
      ['cat', 'CatWritable'],
      ['dog', 'Dog'],
    ]);
    const plain = ir.schemas.get('Animal');
    expect(plain?.kind === 'union' && [...(plain.discriminator?.mapping ?? [])]).toEqual([
      ['cat', 'Cat'],
      ['dog', 'Dog'],
    ]);
  });

  it('treats a schema reachable only via discriminator mapping as a dependency', () => {
    const union: IRSchema = {
      kind: 'union',
      nullable: false,
      variants: [],
      discriminator: { property: 'kind', mapping: new Map([['cat', 'Cat']]) },
    };
    const ir = doc({ Animal: union, Cat: obj({ id: readOnly(str) }) }, [roundTrip(ref('Animal'))]);
    splitReadWrite(ir, {}, new Diagnostics());

    expect(ir.schemas.has('AnimalWritable')).toBe(true);
    const writable = ir.schemas.get('AnimalWritable');
    expect(writable?.kind === 'union' && [...(writable.discriminator?.mapping ?? [])]).toEqual([['cat', 'CatWritable']]);
  });

  it('warns and suffixes when a variant name collides with an existing schema', () => {
    const diagnostics = new Diagnostics();
    const ir = doc({ Pet: obj({ id: readOnly(str) }), PetWritable: obj({ other: str }) }, [roundTrip(ref('Pet'))]);
    splitReadWrite(ir, {}, diagnostics);

    expect(ir.schemas.has('PetWritable2')).toBe(true);
    expect(propNames(ir.schemas.get('PetWritable'))).toEqual(['other']);
    expect(requestSchema(ir)).toEqual(ref('PetWritable2'));
    expect(diagnostics.entries.filter((e) => e.code === 'readwrite-name-conflict')).toHaveLength(1);
  });
});
