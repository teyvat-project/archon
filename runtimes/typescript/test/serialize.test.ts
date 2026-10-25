import { describe, expect, it } from 'vitest';
import { serializeCookie, serializeHeader, serializePath, serializeQuery } from '../src/serialize.js';
import type { ParamSpec, ParamStyle } from '../src/types.js';

const string = 'blue';
const array = ['blue', 'black', 'brown'];
const object = { R: 100, G: 200, B: 150 };

const spec = (
  location: ParamSpec['in'],
  style: ParamStyle,
  explode: boolean,
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({ name: 'color', in: location, style, explode, ...extra });

type Row = [style: ParamStyle, explode: boolean, string?: string, array?: string, object?: string];

// RFC 6570 / OpenAPI 3.x style examples table
const pathRows: Row[] = [
  ['matrix', false, ';color=blue', ';color=blue,black,brown', ';color=R,100,G,200,B,150'],
  ['matrix', true, ';color=blue', ';color=blue;color=black;color=brown', ';R=100;G=200;B=150'],
  ['label', false, '.blue', '.blue,black,brown', '.R,100,G,200,B,150'],
  ['label', true, '.blue', '.blue.black.brown', '.R=100.G=200.B=150'],
  ['simple', false, 'blue', 'blue,black,brown', 'R,100,G,200,B,150'],
  ['simple', true, 'blue', 'blue,black,brown', 'R=100,G=200,B=150'],
];

const queryRows: Row[] = [
  ['form', false, 'color=blue', 'color=blue,black,brown', 'color=R,100,G,200,B,150'],
  ['form', true, 'color=blue', 'color=blue&color=black&color=brown', 'R=100&G=200&B=150'],
  [
    'spaceDelimited',
    false,
    undefined,
    'color=blue%20black%20brown',
    'color=R%20100%20G%20200%20B%20150',
  ],
  ['pipeDelimited', false, undefined, 'color=blue|black|brown', 'color=R|100|G|200|B|150'],
  ['deepObject', true, undefined, undefined, 'color[R]=100&color[G]=200&color[B]=150'],
];

describe('serializePath', () => {
  describe.each(pathRows)('%s explode=%s', (style, explode, s, a, o) => {
    const specs = [spec('path', style, explode)];
    const run = (value: unknown) => serializePath('{color}', specs, { color: value });
    it('string', () => expect(run(string)).toBe(s));
    it('array', () => expect(run(array)).toBe(a));
    it('object', () => expect(run(object)).toBe(o));
  });

  it('substitutes every placeholder and keeps the rest of the template', () => {
    const specs: ParamSpec[] = [
      { name: 'owner', in: 'path', style: 'simple', explode: false },
      { name: 'id', in: 'path', style: 'simple', explode: false },
    ];
    expect(serializePath('/repos/{owner}/items/{id}/raw', specs, { owner: 'me', id: 42 })).toBe(
      '/repos/me/items/42/raw',
    );
  });

  it('percent-encodes reserved chars in path values', () => {
    const specs: ParamSpec[] = [{ name: 'name', in: 'path', style: 'simple', explode: false }];
    expect(serializePath('/files/{name}', specs, { name: 'a/b?c#d e' })).toBe(
      '/files/a%2Fb%3Fc%23d%20e',
    );
    expect(serializePath('/files/{name}', specs, { name: '日本' })).toBe('/files/%E6%97%A5%E6%9C%AC');
  });

  it('does not re-expand placeholders appearing inside substituted values', () => {
    const specs: ParamSpec[] = [
      { name: 'a', in: 'path', style: 'simple', explode: false },
      { name: 'b', in: 'path', style: 'simple', explode: false },
    ];
    expect(serializePath('/{a}/{b}', specs, { a: '{b}', b: 'x' })).toBe('/%7Bb%7D/x');
  });

  it('ignores non-path specs', () => {
    const specs: ParamSpec[] = [
      { name: 'id', in: 'path', style: 'simple', explode: false },
      { name: 'id', in: 'query', style: 'form', explode: true },
    ];
    expect(serializePath('/x/{id}', specs, { id: 1 })).toBe('/x/1');
  });

  it('throws TypeError naming the parameter when a path value is missing', () => {
    const specs: ParamSpec[] = [{ name: 'id', in: 'path', style: 'simple', explode: false }];
    expect(() => serializePath('/x/{id}', specs, {})).toThrow(TypeError);
    expect(() => serializePath('/x/{id}', specs, undefined)).toThrow(/id/);
    expect(() => serializePath('/x/{id}', specs, { id: null })).toThrow(/id/);
  });

  it('emits only the prefix for empty arrays and objects', () => {
    // `p` keeps the segment non-empty / not a dot segment (those are rejected, see below).
    const run = (style: ParamStyle, explode: boolean, value: unknown) =>
      serializePath('p{color}', [spec('path', style, explode)], { color: value });
    expect(run('label', false, [])).toBe('p.');
    expect(run('label', true, {})).toBe('p.');
    expect(run('matrix', false, [])).toBe('p;color');
    expect(run('matrix', true, {})).toBe('p;color');
    expect(run('simple', false, [])).toBe('p');
    expect(run('simple', true, {})).toBe('p');
  });

  it('emits matrix without "=" for an empty string', () => {
    expect(serializePath('{color}', [spec('path', 'matrix', false)], { color: '' })).toBe(';color');
  });

  it('serializes Date as ISO string', () => {
    const specs: ParamSpec[] = [{ name: 'at', in: 'path', style: 'simple', explode: false }];
    expect(serializePath('/{at}', specs, { at: new Date('2024-01-02T03:04:05.000Z') })).toBe(
      '/2024-01-02T03%3A04%3A05.000Z',
    );
  });
});

describe('serializeQuery', () => {
  describe.each(queryRows)('%s explode=%s', (style, explode, s, a, o) => {
    const specs = [spec('query', style, explode)];
    const run = (value: unknown) => serializeQuery(specs, { color: value });
    if (s !== undefined) it('string', () => expect(run(string)).toBe(s));
    if (a !== undefined) it('array', () => expect(run(array)).toBe(a));
    if (o !== undefined) it('object', () => expect(run(object)).toBe(o));
  });

  it('returns an empty string when there are no values', () => {
    expect(serializeQuery([spec('query', 'form', true)], undefined)).toBe('');
    expect(serializeQuery([], {})).toBe('');
  });

  it('joins multiple parameters with & in spec order and ignores non-query specs', () => {
    const specs: ParamSpec[] = [
      { name: 'limit', in: 'query', style: 'form', explode: true },
      { name: 'x-trace', in: 'header', style: 'simple', explode: false },
      { name: 'tags', in: 'query', style: 'form', explode: true },
    ];
    expect(serializeQuery(specs, { tags: ['a', 'b'], limit: 10, 'x-trace': 'z' })).toBe(
      'limit=10&tags=a&tags=b',
    );
  });

  it('skips undefined and null', () => {
    const specs: ParamSpec[] = [
      { name: 'a', in: 'query', style: 'form', explode: true },
      { name: 'b', in: 'query', style: 'form', explode: true },
      { name: 'c', in: 'query', style: 'form', explode: true },
    ];
    expect(serializeQuery(specs, { a: undefined, b: null, c: 'x' })).toBe('c=x');
    expect(serializeQuery([spec('query', 'form', true)], { color: ['a', null, undefined, 'b'] })).toBe(
      'color=a&color=b',
    );
    expect(
      serializeQuery([spec('query', 'form', true)], { color: { a: 1, b: null, c: undefined } }),
    ).toBe('a=1');
  });

  it('serializes Date as ISO string and keeps boolean / number as String()', () => {
    const specs: ParamSpec[] = [
      { name: 'since', in: 'query', style: 'form', explode: true },
      { name: 'flag', in: 'query', style: 'form', explode: true },
      { name: 'n', in: 'query', style: 'form', explode: true },
    ];
    expect(
      serializeQuery(specs, { since: new Date('2024-01-02T03:04:05.000Z'), flag: false, n: 0 }),
    ).toBe('since=2024-01-02T03%3A04%3A05.000Z&flag=false&n=0');
  });

  it('percent-encodes names and values', () => {
    const specs: ParamSpec[] = [{ name: 'q r', in: 'query', style: 'form', explode: true }];
    expect(serializeQuery(specs, { 'q r': 'a&b=c+d/日' })).toBe('q%20r=a%26b%3Dc%2Bd%2F%E6%97%A5');
  });

  it('allowReserved keeps reserved chars in query', () => {
    const specs: ParamSpec[] = [
      { name: 'path', in: 'query', style: 'form', explode: true, allowReserved: true },
    ];
    expect(serializeQuery(specs, { path: "/a/b?c=d&e#f[g]@h:i!$'()*+,;" })).toBe(
      "path=/a/b?c=d&e#f[g]@h:i!$'()*+,;",
    );
  });

  it('allowReserved still encodes non-reserved unsafe chars', () => {
    const specs: ParamSpec[] = [
      { name: 'p', in: 'query', style: 'form', explode: true, allowReserved: true },
    ];
    expect(serializeQuery(specs, { p: 'a b/日%' })).toBe('p=a%20b/%E6%97%A5%25');
  });

  it('without allowReserved, reserved chars are encoded', () => {
    const specs: ParamSpec[] = [{ name: 'p', in: 'query', style: 'form', explode: true }];
    expect(serializeQuery(specs, { p: '/?#[]@:+,;=' })).toBe('p=%2F%3F%23%5B%5D%40%3A%2B%2C%3B%3D');
  });

  it('form explode=false with an empty array emits "color="', () => {
    expect(serializeQuery([spec('query', 'form', false)], { color: [] })).toBe('color=');
  });

  it('form explode=true with an empty array is omitted', () => {
    expect(serializeQuery([spec('query', 'form', true)], { color: [] })).toBe('');
    expect(serializeQuery([spec('query', 'form', true)], { color: {} })).toBe('');
  });

  it('delimited styles keep literal delimiters but encode delimiter chars inside values', () => {
    expect(serializeQuery([spec('query', 'pipeDelimited', false)], { color: ['a|b', 'c'] })).toBe(
      'color=a%7Cb|c',
    );
  });

  it('deepObject nests objects', () => {
    expect(
      serializeQuery([spec('query', 'deepObject', true)], { color: { a: { b: 1 }, c: 'x y' } }),
    ).toBe('color[a][b]=1&color[c]=x%20y');
  });
});

describe('serializeHeader', () => {
  const header = (style: ParamStyle, explode: boolean) => spec('header', style, explode);

  it.each([
    [false, 'blue', 'blue,black,brown', 'R,100,G,200,B,150'],
    [true, 'blue', 'blue,black,brown', 'R=100,G=200,B=150'],
  ])('simple explode=%s', (explode, s, a, o) => {
    expect(serializeHeader(header('simple', explode), string)).toBe(s);
    expect(serializeHeader(header('simple', explode), array)).toBe(a);
    expect(serializeHeader(header('simple', explode), object)).toBe(o);
  });

  it('does not percent-encode', () => {
    expect(serializeHeader(header('simple', false), 'a b/日,c')).toBe('a b/日,c');
  });

  it('returns undefined for undefined and null', () => {
    expect(serializeHeader(header('simple', false), undefined)).toBeUndefined();
    expect(serializeHeader(header('simple', false), null)).toBeUndefined();
  });

  it('serializes Date, boolean and number', () => {
    expect(serializeHeader(header('simple', false), new Date('2024-01-02T03:04:05.000Z'))).toBe(
      '2024-01-02T03:04:05.000Z',
    );
    expect(serializeHeader(header('simple', false), true)).toBe('true');
    expect(serializeHeader(header('simple', false), 0)).toBe('0');
  });

  it('rejects CR and LF with TypeError', () => {
    expect(() => serializeHeader(header('simple', false), 'a\r\nInjected: 1')).toThrow(TypeError);
    expect(() => serializeHeader(header('simple', false), 'a\nb')).toThrow(TypeError);
    expect(() => serializeHeader(header('simple', false), ['ok', 'b\rc'])).toThrow(TypeError);
  });
});

describe('serializeCookie', () => {
  it("joins with '; '", () => {
    const specs: ParamSpec[] = [
      { name: 'a', in: 'cookie', style: 'form', explode: true },
      { name: 'b', in: 'cookie', style: 'form', explode: true },
    ];
    expect(serializeCookie(specs, { a: 1, b: 'two' })).toBe('a=1; b=two');
  });

  it('percent-encodes values', () => {
    const specs: ParamSpec[] = [{ name: 'a', in: 'cookie', style: 'form', explode: true }];
    expect(serializeCookie(specs, { a: 'x y;z=日' })).toBe('a=x%20y%3Bz%3D%E6%97%A5');
  });

  it('uses form rules for arrays and objects', () => {
    expect(serializeCookie([spec('cookie', 'form', false)], { color: array })).toBe(
      'color=blue,black,brown',
    );
    expect(serializeCookie([spec('cookie', 'form', true)], { color: array })).toBe(
      'color=blue; color=black; color=brown',
    );
    expect(serializeCookie([spec('cookie', 'form', true)], { color: object })).toBe(
      'R=100; G=200; B=150',
    );
  });

  it('returns undefined when nothing to send and ignores non-cookie specs', () => {
    const specs: ParamSpec[] = [
      { name: 'a', in: 'cookie', style: 'form', explode: true },
      { name: 'q', in: 'query', style: 'form', explode: true },
    ];
    expect(serializeCookie(specs, undefined)).toBeUndefined();
    expect(serializeCookie(specs, { a: null, q: 'x' })).toBeUndefined();
  });
});

describe('path traversal protection', () => {
  const simple: ParamSpec = { name: 'id', in: 'path', style: 'simple', explode: false };

  it.each(['..', '.', ''])('rejects a simple value %j that would form a dot / empty segment', (value) => {
    expect(() => serializePath('/x/{id}', [simple], { id: value })).toThrow(TypeError);
    expect(() => serializePath('/x/{id}', [simple], { id: value })).toThrow(/"id"/);
  });

  it('rejects empty arrays / objects that serialize to an empty segment', () => {
    expect(() => serializePath('/x/{id}', [simple], { id: [] })).toThrow(TypeError);
    expect(() => serializePath('/x/{id}', [{ ...simple, explode: true }], { id: {} })).toThrow(TypeError);
  });

  it('rejects label values whose segment becomes "." or ".."', () => {
    const label: ParamSpec = { ...simple, style: 'label' };
    expect(() => serializePath('/x/{id}', [label], { id: '' })).toThrow(TypeError);
    expect(() => serializePath('/x/{id}', [label], { id: '.' })).toThrow(TypeError);
    expect(() => serializePath('/x/{id}', [label], { id: [] })).toThrow(TypeError);
    // `...` is not a dot segment
    expect(serializePath('/x/{id}', [label], { id: '..' })).toBe('/x/...');
  });

  it('rejects when adjacent placeholders together form a dot segment', () => {
    const specs: ParamSpec[] = [simple, { ...simple, name: 'ext' }];
    expect(() => serializePath('/x/{id}{ext}', specs, { id: '.', ext: '.' })).toThrow(TypeError);
  });

  it('keeps values that are only part of a segment or contain dots', () => {
    expect(serializePath('/files/{id}.json', [simple], { id: '' })).toBe('/files/.json');
    expect(serializePath('/x/{id}', [simple], { id: '...' })).toBe('/x/...');
    expect(serializePath('/x/{id}', [simple], { id: '.hidden' })).toBe('/x/.hidden');
    expect(serializePath('/x/{id}', [{ ...simple, style: 'matrix' }], { id: '..' })).toBe('/x/;id=..');
    expect(serializePath('/x/{id}', [{ ...simple, style: 'matrix' }], { id: '' })).toBe('/x/;id');
  });

  it('ignores allowReserved for path parameters', () => {
    const reserved: ParamSpec = { ...simple, allowReserved: true };
    expect(serializePath('/x/{id}', [reserved], { id: '../a/b?c#d' })).toBe('/x/..%2Fa%2Fb%3Fc%23d');
  });

  it('ignores allowReserved for cookie parameters', () => {
    const cookie: ParamSpec = { name: 'c', in: 'cookie', style: 'form', explode: true, allowReserved: true };
    expect(serializeCookie([cookie], { c: 'a;b=c' })).toBe('c=a%3Bb%3Dc');
  });
});
