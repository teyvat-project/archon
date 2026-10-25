import { describe, expect, it } from 'vitest';
import { goString, importsFor, isValidTagName } from '../../../src/plugins/go/emit.js';
import { buildNames, exported, resolveModule, resolvePackageName, unexported } from '../../../src/plugins/go/names.js';
import { doc, obj, options, prop, str } from './helpers.js';

describe('go plugin: names', () => {
  it('sanitizes and dedupes type names in one package namespace', () => {
    const ir = doc({
      'Foo.Bar': obj([prop('a', str)]),
      '1Thing': obj([prop('a', str)]),
      'foo-bar': obj([prop('a', str)]),
      Client: obj([prop('a', str)]),
      Auth: obj([prop('a', str)]),
      PetsService: obj([prop('a', str)]),
      Test: obj([prop('a', str)]),
      Thing_linux: obj([prop('a', str)]),
    });
    const names = buildNames(ir, options(), ['PetsService']);
    expect(Object.fromEntries(names.types)).toEqual({
      'Foo.Bar': 'FooBar',
      '1Thing': 'X1Thing',
      'foo-bar': 'FooBar2',
      Client: 'Client2',
      Auth: 'Auth2',
      PetsService: 'PetsService2',
      Test: 'Test',
      Thing_linux: 'ThingLinux',
    });
    expect(names.files.get('Test')).toBe('test_model.go');
    expect(names.files.get('Foo.Bar')).toBe('foo_bar_model.go');
    // A later claim adapts to the names taken.
    expect(names.claim('FooBar')).toBe('FooBar3');
    expect(names.claimLocal('securitySchemes')).toBe('securitySchemes2');
  });

  it('keeps file names clear of build constraints and test files', () => {
    const names = buildNames(doc({ Win: obj([prop('a', str)]) }), options({ hooks: { fileName: () => 'thing_windows' } }), []);
    expect(names.files.get('Win')).toBe('thing_windows_.go');
    const other = buildNames(doc({ A: obj([prop('a', str)]) }), options(), []);
    expect(other.claimFile('x_test')).toBe('x_test_.go');
    expect(other.claimFile('client')).toBe('client2.go');
  });

  it('names fields uniquely ignoring case and away from generated methods', () => {
    const ir = doc({
      Weird: obj([prop('x-foo', str), prop('2fa', str), prop('foo_bar', str), prop('fooBar', str), prop('FooBar', str), prop('unmarshalJSON', str), prop('type', str)]),
    });
    const fields = buildNames(ir, options(), []).fields('Weird');
    expect(Object.fromEntries(fields)).toEqual({
      'x-foo': 'XFoo',
      '2fa': 'X2fa',
      foo_bar: 'FooBar',
      fooBar: 'FooBar2',
      FooBar: 'FooBar3',
      unmarshalJSON: 'UnmarshalJson2',
      type: 'Type',
    });
  });

  it('derives the package name and module', () => {
    const ir = doc({}, [], { info: { title: 'Archon Edge Cases', version: '1' } });
    expect(resolvePackageName(ir, options({ packageName: undefined }))).toBe('archonedgecases');
    expect(resolvePackageName(doc({}, [], { info: { title: '!!!', version: '1' } }), options({ packageName: undefined }))).toBe('api');
    expect(resolvePackageName(doc({}, [], { info: { title: '2fa', version: '1' } }), options({ packageName: undefined }))).toBe('api2fa');
    expect(resolvePackageName(ir, options({ packageName: 'type' }))).toBe('type_');
    expect(resolveModule('archonedgecases', options())).toBe('archonedgecases');
    expect(resolveModule('x', options({ module: 'github.com/acme/x' }))).toBe('github.com/acme/x');
  });

  it('builds exported and unexported identifiers', () => {
    expect(exported('fooBar')).toBe('FooBar');
    expect(exported('_x')).toBe('X_x');
    expect(unexported('Type')).toBe('type_');
    expect(unexported('GetThing')).toBe('getThing');
  });

  it('writes Go string literals and finds the imports a body uses', () => {
    expect(goString('a"b\\c\n\t\u0001\uD800é')).toBe('"a\\"b\\\\c\\n\\t\\x01\\uFFFDé"');
    const body = '// time.Time in a comment\nvar x = "json.Marshal"\ntype T struct {\n\tA time.Time `json:"a"`\n}\nfunc f() { core.Do() }\n';
    expect(importsFor(body, 'example.com/m').sort()).toEqual(['example.com/m/core', 'time']);
    expect(isValidTagName('x-foo')).toBe(true);
    expect(isValidTagName('日本')).toBe(true);
    expect(isValidTagName('a,b')).toBe(false);
    expect(isValidTagName('a"b')).toBe(false);
    expect(isValidTagName('')).toBe(false);
  });
});
