import { describe, expect, it } from 'vitest';
import { buildNames, csIdentifier, escapeKeyword } from '../../../src/plugins/csharp/names.js';
import { doc, obj, options, prop, str } from './helpers.js';

describe('csharp plugin: names', () => {
  it('sanitizes type and member names', () => {
    const ir = doc({
      'Foo.Bar': obj([prop('a', str)]),
      '1Thing': obj([prop('a', str)]),
      'foo-bar': obj([prop('a', str)]),
      ApiRequest: obj([prop('a', str)]),
      Echo: obj([
        prop('x-foo', str),
        prop('2fa', str),
        prop('foo_bar', str),
        prop('fooBar', str),
        prop('echo', str),
        prop('class', str),
        prop('equals', str),
      ]),
    });
    const names = buildNames(ir, options(), ['ApiRequest']);
    expect([...names.types.values()]).toEqual(['FooBar', '_1Thing', 'FooBar2', 'ApiRequest2', 'Echo']);
    expect([...names.members('Echo').entries()]).toEqual([
      ['x-foo', 'XFoo'],
      ['2fa', '_2fa'],
      ['foo_bar', 'FooBar'],
      ['fooBar', 'FooBar2'],
      ['echo', 'EchoValue'],
      ['class', 'Class'],
      ['equals', 'EqualsValue'],
    ]);
  });

  it('treats type names case-insensitively (one file per type)', () => {
    const names = buildNames(doc({ pet: obj([prop('a', str)]), Pet: obj([prop('a', str)]) }), options(), []);
    expect([...names.types.values()]).toEqual(['Pet', 'Pet2']);
  });

  it('applies naming rules and hooks', () => {
    const ir = doc({ pet: obj([prop('pet_name', str)]) });
    const names = buildNames(
      ir,
      options({ naming: { type: { name: 'Api{{name}}' } }, hooks: { propertyName: (n) => (n === 'pet_name' ? 'Label' : undefined) } }),
      [],
    );
    expect(names.types.get('pet')).toBe('ApiPet');
    expect(names.members('pet').get('pet_name')).toBe('Label');
  });

  it('escapes keywords and leading digits', () => {
    expect(escapeKeyword('class')).toBe('@class');
    expect(escapeKeyword('Class')).toBe('Class');
    expect(csIdentifier('2fa', 'camelCase')).toBe('_2fa');
    expect(csIdentifier('x-request-ids', 'camelCase')).toBe('xRequestIds');
    expect(csIdentifier('', 'PascalCase')).toBe('_');
  });
});
