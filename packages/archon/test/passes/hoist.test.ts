import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IRMediaType, IROperation, IRParameter, IRSchema } from '../../src/ir/types.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import { parseDocument } from '../../src/parser/index.js';
import { inferDiscriminators } from '../../src/passes/discriminator.js';
import { hoistInlineSchemas } from '../../src/passes/hoist.js';

const str: IRSchema = { kind: 'string', nullable: false };
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const tag = (...values: string[]): IRSchema => ({ kind: 'enum', nullable: false, base: 'string', values });
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
const union = (variants: IRSchema[], extra: Record<string, unknown> = {}): IRSchema =>
  ({ kind: 'union', nullable: false, variants, ...extra }) as IRSchema;
const json = (schema: IRSchema, mediaType = 'application/json'): IRMediaType => ({ mediaType, kind: 'json', schema });

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

function param(name: string, schema: IRSchema): IRParameter {
  return {
    name,
    in: 'query',
    required: false,
    deprecated: false,
    schema,
    style: 'form',
    explode: true,
    allowReserved: false,
  };
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

const both = { objects: true, enums: true };
const prop = (s: IRSchema | undefined, name: string): IRSchema | undefined =>
  s?.kind === 'object' ? s.properties.find((p) => p.name === name)?.schema : undefined;

describe('hoistInlineSchemas', () => {
  it('hoists nested inline objects with Parent+Prop names', () => {
    const ir = doc({
      User: obj({
        id: str,
        profile: obj({ bio: str, links: obj({ site: str }) }),
        tags: arr(obj({ label: str })),
      }),
    });
    hoistInlineSchemas(ir, both);

    // 親 → 子の順で、既存 schema の後ろに追加される
    expect([...ir.schemas.keys()]).toEqual(['User', 'UserProfile', 'UserProfileLinks', 'UserTagsItem']);
    const user = ir.schemas.get('User');
    expect(prop(user, 'profile')).toEqual(ref('UserProfile'));
    expect(prop(user, 'tags')).toEqual(arr(ref('UserTagsItem')));
    expect(prop(ir.schemas.get('UserProfile'), 'links')).toEqual(ref('UserProfileLinks'));
    expect(prop(ir.schemas.get('UserProfile'), 'bio')).toEqual(str);
  });

  it('keeps usage-site meta on the ref and gives the hoisted schema nullable=false', () => {
    const profile = {
      ...obj({ bio: str }),
      nullable: true,
      title: 'Profile',
      description: 'the profile',
      deprecated: true,
      readOnly: true,
      default: null,
      origin: '#/x',
    } as IRSchema;
    const ir = doc({ User: obj({ profile }) });
    hoistInlineSchemas(ir, both);

    expect(prop(ir.schemas.get('User'), 'profile')).toEqual({
      kind: 'ref',
      name: 'UserProfile',
      nullable: true,
      description: 'the profile',
      deprecated: true,
      readOnly: true,
      default: null,
      origin: '#/x',
    });
    const hoisted = ir.schemas.get('UserProfile');
    expect(hoisted?.nullable).toBe(false);
    expect(hoisted?.title).toBe('Profile');
    expect(hoisted?.description).toBe('the profile');
    expect(hoisted?.readOnly).toBeUndefined();
    expect(hoisted?.default).toBeUndefined();
  });

  it('hoists inline enums only when enums=true', () => {
    const make = () => doc({ User: obj({ role: tag('admin', 'member'), profile: obj({ mood: tag('a', 'b') }) }) });

    const on = make();
    hoistInlineSchemas(on, both);
    expect([...on.schemas.keys()]).toEqual(['User', 'UserRole', 'UserProfile', 'UserProfileMood']);
    expect(prop(on.schemas.get('User'), 'role')).toEqual(ref('UserRole'));
    expect(on.schemas.get('UserRole')).toEqual(tag('admin', 'member'));

    // enums=false, objects=true: enum は hoist されたオブジェクトの中でも inline のまま
    const off = make();
    hoistInlineSchemas(off, { objects: true, enums: false });
    expect([...off.schemas.keys()]).toEqual(['User', 'UserProfile']);
    expect(prop(off.schemas.get('User'), 'role')).toEqual(tag('admin', 'member'));
    expect(prop(off.schemas.get('UserProfile'), 'mood')).toEqual(tag('a', 'b'));
  });

  it('hoists enums inside objects that stay inline when objects=false', () => {
    const ir = doc({ User: obj({ profile: obj({ mood: tag('a', 'b') }) }) });
    hoistInlineSchemas(ir, { objects: false, enums: true });
    expect([...ir.schemas.keys()]).toEqual(['User', 'UserProfileMood']);
    expect(prop(prop(ir.schemas.get('User'), 'profile'), 'mood')).toEqual(ref('UserProfileMood'));
  });

  it('never hoists a top-level named object or enum', () => {
    const ir = doc({ Role: tag('a', 'b'), Box: obj({ n: str }) });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Role', 'Box']);
  });

  it('names union variants by discriminator value, otherwise Variant{N}', () => {
    const ir = doc({
      Shape: obj({
        emoji: union(
          [obj({ type: tag('standard'), value: str }), obj({ type: tag('custom_emoji'), id: str })],
          { discriminator: { property: 'type', mapping: new Map([['standard', ''], ['custom_emoji', '']]) } },
        ),
        either: union([obj({ a: str }), obj({ b: str }), str]),
      }),
    });
    hoistInlineSchemas(ir, { objects: true, enums: false });

    expect([...ir.schemas.keys()]).toEqual([
      'Shape',
      'ShapeEmojiStandard',
      'ShapeEmojiCustomEmoji',
      'ShapeEitherVariant1',
      'ShapeEitherVariant2',
    ]);
    const either = prop(ir.schemas.get('Shape'), 'either');
    expect(either?.kind === 'union' && either.variants).toEqual([ref('ShapeEitherVariant1'), ref('ShapeEitherVariant2'), str]);
  });

  it('fills discriminator mapping for hoisted variants and leaves ref mappings alone', () => {
    const ir = doc({
      Cat: obj({ kind: tag('cat') }),
      Pet: union(
        [ref('Cat'), obj({ kind: tag('dog'), bark: str })],
        { discriminator: { property: 'kind', mapping: new Map([['cat', 'Cat'], ['dog', '']]) } },
      ),
    });
    hoistInlineSchemas(ir, { objects: true, enums: false });

    const pet = ir.schemas.get('Pet');
    expect(pet?.kind === 'union' && pet.variants).toEqual([ref('Cat'), ref('PetDog')]);
    expect(pet?.kind === 'union' && pet.discriminator).toEqual({
      property: 'kind',
      mapping: new Map([['cat', 'Cat'], ['dog', 'PetDog']]),
    });
  });

  it('matches mapping keys to variants by tag value, not by position', () => {
    const ir = doc({
      Pet: union(
        [obj({ kind: tag('dog') }), obj({ kind: tag('cat') })],
        { discriminator: { property: 'kind', mapping: new Map([['cat', ''], ['dog', '']]) } },
      ),
    });
    hoistInlineSchemas(ir, { objects: true, enums: false });
    const pet = ir.schemas.get('Pet');
    expect(pet?.kind === 'union' && pet.discriminator?.mapping).toEqual(
      new Map([['cat', 'PetCat'], ['dog', 'PetDog']]),
    );
  });

  it('keeps the discriminator property inline (not hoisted) even with enums=true', () => {
    const ir = doc({
      Pet: union(
        [obj({ kind: tag('dog') }), obj({ kind: tag('cat') })],
        { discriminator: { property: 'kind', mapping: new Map([['cat', ''], ['dog', '']]) } },
      ),
    });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Pet', 'PetDog', 'PetCat']);
    expect(prop(ir.schemas.get('PetCat'), 'kind')).toEqual(tag('cat'));
    expect(prop(ir.schemas.get('PetDog'), 'kind')).toEqual(tag('dog'));
    const pet = ir.schemas.get('Pet');
    expect(pet?.kind === 'union' && pet.discriminator?.mapping).toEqual(
      new Map([['cat', 'PetCat'], ['dog', 'PetDog']]),
    );
  });

  it('still hoists other enums (including single-value ones) inside discriminated variants', () => {
    const ir = doc({
      Pet: union(
        [obj({ kind: tag('dog'), mode: tag('only') }), obj({ kind: tag('cat'), size: tag('s', 'l') })],
        { discriminator: { property: 'kind', mapping: new Map([['cat', ''], ['dog', '']]) } },
      ),
    });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Pet', 'PetDog', 'PetDogMode', 'PetCat', 'PetCatSize']);
    expect(prop(ir.schemas.get('PetDog'), 'kind')).toEqual(tag('dog'));
    expect(prop(ir.schemas.get('PetDog'), 'mode')).toEqual(ref('PetDogMode'));
  });

  it('hoists a non-discriminator single-value enum when enums=true', () => {
    const ir = doc({ Box: obj({ version: tag('v1') }) });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Box', 'BoxVersion']);
  });

  it('suffixes conflicting names with 2, 3…', () => {
    const ir = doc({
      UserProfile: obj({ x: str }),
      User: obj({ profile: obj({ a: str }) }),
      Account: obj({ user: obj({ a: str }) }),
      AccountUser: obj({ y: str }),
      Team: obj({ profile: obj({ a: str }), team: obj({ a: str }) }),
      TeamProfile: obj({ z: str }),
      TeamProfile2: obj({ z: str }),
    });
    hoistInlineSchemas(ir, both);

    expect(prop(ir.schemas.get('User'), 'profile')).toEqual(ref('UserProfile2'));
    expect(prop(ir.schemas.get('Account'), 'user')).toEqual(ref('AccountUser2'));
    // 既存の TeamProfile / TeamProfile2 を避ける
    expect(prop(ir.schemas.get('Team'), 'profile')).toEqual(ref('TeamProfile3'));
    expect(prop(ir.schemas.get('Team'), 'team')).toEqual(ref('TeamTeam'));
  });

  it('suffixes names claimed twice by hoisting itself (multiple media types)', () => {
    const ir = doc(
      {},
      [
        op('createUser', {
          requestBody: { required: true, contents: [json(obj({ a: str })), json(obj({ a: str }), 'multipart/form-data')] },
        }),
      ],
    );
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['CreateUserBody', 'CreateUserBody2']);
  });

  it('uses nameHook result when provided, and falls back to the suggestion on undefined', () => {
    const ir = doc({ User: obj({ profile: obj({ bio: str, links: obj({ site: str }) }) }) });
    const calls: { path: string[]; suggested: string }[] = [];
    hoistInlineSchemas(ir, {
      ...both,
      nameHook: (path, { suggested }) => {
        calls.push({ path, suggested });
        return suggested === 'UserProfile' ? 'Profile' : undefined;
      },
    });

    expect(calls).toEqual([
      { path: ['schemas', 'User', 'properties', 'profile'], suggested: 'UserProfile' },
      // 子の命名には親の確定名を使う
      { path: ['schemas', 'User', 'properties', 'profile', 'properties', 'links'], suggested: 'ProfileLinks' },
    ]);
    expect([...ir.schemas.keys()]).toEqual(['User', 'Profile', 'ProfileLinks']);
  });

  it('claims a nameHook name uniquely too', () => {
    const ir = doc({ Profile: obj({ x: str }), User: obj({ profile: obj({ a: str }) }) });
    hoistInlineSchemas(ir, { ...both, nameHook: () => 'Profile' });
    expect(prop(ir.schemas.get('User'), 'profile')).toEqual(ref('Profile2'));
  });

  it('does not hoist empty objects (additionalProperties-only maps)', () => {
    const map = obj({}, [], { additionalProperties: str });
    const empty = obj({}, [], {});
    const ir = doc({ Bag: obj({ map, empty, closed: obj({}, [], { additionalProperties: false }) }) });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Bag']);
    expect(prop(ir.schemas.get('Bag'), 'map')).toEqual(map);
    expect(prop(ir.schemas.get('Bag'), 'empty')).toEqual(empty);
  });

  it('hoists objects used as map values and tuple members', () => {
    const ir = doc({
      Bag: obj({
        map: obj({}, [], { additionalProperties: obj({ a: str }) }),
        pair: { kind: 'tuple', nullable: false, items: [obj({ a: str }), str] } as IRSchema,
      }),
    });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Bag', 'BagMapValue', 'BagPairItem1']);
  });

  it('hoists named-schema roots that are arrays / unions by naming their children after the schema', () => {
    const ir = doc({
      Items: arr(obj({ a: str })),
      Choice: union([obj({ a: str }), obj({ b: str })]),
    });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Items', 'Choice', 'ItemsItem', 'ChoiceVariant1', 'ChoiceVariant2']);
    expect(ir.schemas.get('Items')).toEqual(arr(ref('ItemsItem')));
  });

  it('names operation positions: body, response, parameter (PascalCase op name)', () => {
    const ir = doc(
      { Existing: obj({ a: str }) },
      [
        op('createUser', {
          parameters: [param('sort', tag('asc', 'desc')), param('filter', obj({ q: str })), param('limit', str)],
          requestBody: { required: true, contents: [json(obj({ name: str, address: obj({ city: str }) }))] },
          responses: [
            { status: 201, headers: new Map(), contents: [json(obj({ id: str }))] },
            { status: 'default', headers: new Map(), contents: [json(arr(obj({ message: str })))] },
          ],
        }),
      ],
    );
    hoistInlineSchemas(ir, both);

    expect([...ir.schemas.keys()]).toEqual([
      'Existing',
      'CreateUserSort',
      'CreateUserFilter',
      'CreateUserBody',
      'CreateUserBodyAddress',
      'CreateUserResponse201',
      'CreateUserResponseDefaultItem',
    ]);
    const o = ir.operations[0] as IROperation;
    expect(o.parameters.map((p) => p.schema)).toEqual([ref('CreateUserSort'), ref('CreateUserFilter'), str]);
    expect(o.requestBody?.contents[0]?.schema).toEqual(ref('CreateUserBody'));
    expect(o.responses[0]?.contents[0]?.schema).toEqual(ref('CreateUserResponse201'));
    expect(o.responses[1]?.contents[0]?.schema).toEqual(arr(ref('CreateUserResponseDefaultItem')));
  });

  it('processes named schemas first, then operations in order, passing walk-style paths to nameHook', () => {
    const ir = doc(
      { A: obj({ x: obj({ a: str }) }) },
      [
        op('first', { requestBody: { required: true, contents: [json(obj({ a: str }))] } }),
        op('second', { requestBody: { required: true, contents: [json(obj({ a: str }))] } }),
      ],
    );
    const paths: string[][] = [];
    hoistInlineSchemas(ir, { ...both, nameHook: (p) => (paths.push(p), undefined) });
    expect([...ir.schemas.keys()]).toEqual(['A', 'AX', 'FirstBody', 'SecondBody']);
    expect(paths).toEqual([
      ['schemas', 'A', 'properties', 'x'],
      ['operations', 'GET /first', 'requestBody', 'application/json'],
      ['operations', 'GET /second', 'requestBody', 'application/json'],
    ]);
  });

  it('does not loop on self-referencing / mutually-referencing schemas', () => {
    const ir = doc({
      Comment: obj({ body: str, replies: arr(ref('Comment')), meta: obj({ parent: ref('Comment') }) }),
      A: obj({ b: ref('B') }),
      B: obj({ a: ref('A') }),
    });
    hoistInlineSchemas(ir, both);
    expect([...ir.schemas.keys()]).toEqual(['Comment', 'A', 'B', 'CommentMeta']);
    expect(prop(ir.schemas.get('Comment'), 'replies')).toEqual(arr(ref('Comment')));
    expect(prop(ir.schemas.get('CommentMeta'), 'parent')).toEqual(ref('Comment'));
  });

  it('does nothing when both objects and enums are false', () => {
    const ir = doc({ User: obj({ role: tag('a'), profile: obj({ a: str }) }) });
    const before = structuredClone(ir.schemas);
    hoistInlineSchemas(ir, { objects: false, enums: false });
    expect(ir.schemas).toEqual(before);
  });

  it('fills the natsuneko User.profileEmoji mapping with hoisted variant names', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const ir = parseDocument(raw, { diagnostics: new Diagnostics() });
    inferDiscriminators(ir);
    hoistInlineSchemas(ir, { objects: true, enums: false });

    const emoji = prop(ir.schemas.get('User'), 'profileEmoji');
    expect(emoji?.kind).toBe('union');
    if (emoji?.kind !== 'union') return;
    expect(emoji.variants.map((v) => v.kind === 'ref' && v.name)).toEqual(['UserProfileEmojiStandard', 'UserProfileEmojiCustom']);
    expect(emoji.discriminator).toEqual({
      property: 'type',
      mapping: new Map([
        ['standard', 'UserProfileEmojiStandard'],
        ['custom', 'UserProfileEmojiCustom'],
      ]),
    });
    expect(ir.schemas.get('UserProfileEmojiStandard')?.kind).toBe('object');
    expect(ir.schemas.get('UserProfileEmojiCustom')?.kind).toBe('object');
  });

  it('does not hoist the natsuneko profileEmoji discriminator enum with enums=true', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const ir = parseDocument(raw, { diagnostics: new Diagnostics() });
    inferDiscriminators(ir);
    hoistInlineSchemas(ir, { objects: true, enums: true });

    expect([...ir.schemas.keys()].filter((n) => /^UserProfileEmoji.*Type$/.test(n))).toEqual([]);
    expect(prop(ir.schemas.get('UserProfileEmojiStandard'), 'type')).toMatchObject({ kind: 'enum', values: ['standard'] });
    expect(prop(ir.schemas.get('UserProfileEmojiCustom'), 'type')).toMatchObject({ kind: 'enum', values: ['custom'] });
    const emoji = prop(ir.schemas.get('User'), 'profileEmoji');
    expect(emoji?.kind === 'union' && emoji.discriminator?.mapping).toEqual(
      new Map([
        ['standard', 'UserProfileEmojiStandard'],
        ['custom', 'UserProfileEmojiCustom'],
      ]),
    );
  });
});
