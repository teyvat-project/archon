import { describe, expect, it } from 'vitest';
import { kdoc, literal } from '../../../src/plugins/kotlin/emit.js';
import { buildNames, escapeKeyword, ktIdentifier, resolvePackageName } from '../../../src/plugins/kotlin/names.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';
import { doc, obj, options, prop, str } from './helpers.js';

describe('kotlin plugin: names', () => {
  it('sanitizes type and member names', () => {
    const ir = doc({
      'Foo.Bar': obj([prop('a', str)]),
      '1Thing': obj([prop('a', str)]),
      'foo-bar': obj([prop('a', str)]),
      ApiRequest: obj([prop('a', str)]),
      String: obj([prop('a', str)]),
      Serializable: obj([prop('a', str)]),
      Companion: obj([prop('a', str)]),
      Echo: obj([
        prop('x-foo', str),
        prop('2fa', str),
        prop('foo_bar', str),
        prop('fooBar', str),
        prop('when', str),
        prop('class', str),
        prop('echo', str),
      ]),
    });
    const names = buildNames(ir, options(), ['ApiRequest']);
    expect([...names.types.values()]).toEqual(['FooBar', '_1Thing', 'FooBar2', 'ApiRequest2', 'String2', 'Serializable2', 'Companion2', 'Echo']);
    expect([...names.members('Echo').entries()]).toEqual([
      ['x-foo', 'xFoo'],
      ['2fa', '_2fa'],
      ['foo_bar', 'fooBar'],
      ['fooBar', 'fooBar2'],
      ['when', '`when`'],
      ['class', 'classValue'],
      ['echo', 'echo'],
    ]);
  });

  it('keeps type names case-sensitive but file names case-insensitive', () => {
    const ir = doc({ a: obj([prop('a', str)]), b: obj([prop('a', str)]) });
    const names = buildNames(ir, options({ hooks: { typeName: (n) => (n === 'a' ? 'Pet' : 'PET') } }), []);
    expect([...names.types.values()]).toEqual(['Pet', 'PET']);
    expect([...names.files.values()]).toEqual(['Pet', 'PET2']);
  });

  it('applies naming rules and hooks', () => {
    const ir = doc({ pet: obj([prop('pet_name', str), prop('age', str)]) });
    const names = buildNames(
      ir,
      options({ naming: { type: { name: 'Api{{name}}' }, property: { case: 'snake_case' } }, hooks: { propertyName: (n) => (n === 'pet_name' ? 'label' : undefined) } }),
      [],
    );
    expect(names.types.get('pet')).toBe('ApiPet');
    expect(names.members('pet').get('pet_name')).toBe('label');
    expect(names.members('pet').get('age')).toBe('age');
  });

  it('escapes keywords and leading digits', () => {
    expect(escapeKeyword('when')).toBe('`when`');
    expect(escapeKeyword('value')).toBe('value');
    expect(ktIdentifier('2fa', 'camelCase')).toBe('_2fa');
    expect(ktIdentifier('x-request-ids', 'camelCase')).toBe('xRequestIds');
    expect(ktIdentifier('', 'PascalCase')).toBe('_');
  });

  it('resolves the package name from the title or the option', () => {
    expect(resolvePackageName(doc({}, [], { info: { title: 'Archon Edge Cases', version: '1' } }), options())).toBe('archonedgecases');
    expect(resolvePackageName(doc({}, [], { info: { title: 'My.Cool-API v2', version: '1' } }), options())).toBe('my.coolapiv2');
    expect(resolvePackageName(doc({}, [], { info: { title: '!!!', version: '1' } }), options())).toBe('api');
    expect(resolvePackageName(doc({}, [], { info: { title: '3D.In', version: '1' } }), options())).toBe('_3d.in');
    expect(resolvePackageName(doc({}), options({ packageName: 'com.example.sdk' }))).toBe('com.example.sdk');
  });
});

describe('kotlin plugin: emit', () => {
  it('kdoc breaks comment delimiters', () => {
    const w = new CodeWriter();
    kdoc(w, 'a */ b /* c\nsecond');
    const out = w.toString();
    expect(out.startsWith('/**\n')).toBe(true);
    expect(out.endsWith(' */\n')).toBe(true);
    const inner = out.slice(3, -4);
    expect(inner).not.toContain('*/');
    expect(inner).not.toContain('/*');
    expect(out).toContain(' * second');
  });

  it('kdoc writes nothing for an empty description', () => {
    const w = new CodeWriter();
    kdoc(w, '  ');
    expect(w.toString()).toBe('');
  });

  it('literal escapes dollar, quotes and newlines', () => {
    expect(literal('"$x\n')).toBe('"\\"\\$x\\n"');
    expect(literal('a\\b\t\r\u0001')).toBe('"a\\\\b\\t\\r\\u0001"');
  });
});
