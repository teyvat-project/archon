import { describe, expect, test } from 'vitest';
import { applyTemplate, splitWords, toCase, UniqueNamer } from '../../src/writer/naming.js';

describe('splitWords', () => {
  test('splits on separators, case transitions and acronyms but not digits', () => {
    expect(splitWords('getCatalystV1AlbumById')).toEqual(['get', 'Catalyst', 'V1', 'Album', 'By', 'Id']);
    expect(splitWords('HTTPServer')).toEqual(['HTTP', 'Server']);
    expect(splitWords('x-foo bar')).toEqual(['x', 'foo', 'bar']);
    expect(splitWords('v1.1')).toEqual(['v1', '1']);
    expect(splitWords('')).toEqual([]);
  });
});

describe('toCase', () => {
  test('snake_case keeps V1 as one word', () => {
    expect(toCase('getCatalystV1AlbumByIdById', 'snake_case')).toBe('get_catalyst_v1_album_by_id_by_id');
  });

  test('PascalCase handles separators', () => {
    expect(toCase('x-foo bar', 'PascalCase')).toBe('XFooBar');
  });

  test('camelCase lowers a leading acronym', () => {
    expect(toCase('HTTPServer', 'camelCase')).toBe('httpServer');
  });

  test('other cases', () => {
    expect(toCase('fooBar', 'SCREAMING_SNAKE_CASE')).toBe('FOO_BAR');
    expect(toCase('fooBar', 'kebab-case')).toBe('foo-bar');
    expect(toCase('foo_Bar', 'preserve')).toBe('foo_Bar');
  });
});

describe('applyTemplate', () => {
  test('substitutes {{name}}', () => {
    expect(applyTemplate('Api{{name}}', 'Foo')).toBe('ApiFoo');
    expect(applyTemplate('{{name}}Dto', 'Foo')).toBe('FooDto');
  });

  test('applies a function and falls back to the name', () => {
    expect(applyTemplate((n) => n.toUpperCase(), 'Foo')).toBe('FOO');
    expect(applyTemplate(undefined, 'Foo')).toBe('Foo');
  });
});

describe('UniqueNamer', () => {
  test('suffixes collisions with 2, 3, ...', () => {
    const n = new UniqueNamer();
    expect([n.claim('a'), n.claim('a'), n.claim('a')]).toEqual(['a', 'a2', 'a3']);
  });

  test('honors reserved names', () => {
    expect(new UniqueNamer(['class']).claim('class')).toBe('class2');
  });

  test('detects case-insensitive collisions when asked', () => {
    const n = new UniqueNamer([], { caseInsensitive: true });
    expect([n.claim('Foo'), n.claim('foo')]).toEqual(['Foo', 'foo2']);
    const s = new UniqueNamer();
    expect([s.claim('Foo'), s.claim('foo')]).toEqual(['Foo', 'foo']);
  });
});
