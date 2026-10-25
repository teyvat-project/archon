import { describe, expect, it } from 'vitest';
import { docLines, literal, tomlString } from '../../../src/plugins/rust/emit.js';
import { buildNames, escapeKeyword, packageName } from '../../../src/plugins/rust/names.js';
import { bool, doc, obj, options, prop, str } from './helpers.js';

describe('rust plugin: names', () => {
  it('sanitizes type, module and field names', () => {
    const ir = doc({
      'Foo.Bar': obj([prop('a', str)]),
      '1Thing': obj([prop('a', str)]),
      String: obj([prop('a', str)]),
      Vec: obj([prop('a', str)]),
      Self: obj([prop('a', str)]),
      ApiClient: obj([prop('a', str)]),
      Weird: obj([
        prop('type', str),
        prop('self', str),
        prop('crate', str),
        prop('x-foo', str),
        prop('2fa', bool),
        prop('foo_bar', str),
        prop('fooBar', str),
        prop('FooBar', str),
        prop('_', str),
      ]),
    });
    const names = buildNames(ir, options(), ['ApiClient']);
    expect(Object.fromEntries(names.types)).toEqual({
      'Foo.Bar': 'FooBar',
      '1Thing': '_1Thing',
      String: 'String2',
      Vec: 'Vec2',
      Self: 'Self2',
      ApiClient: 'ApiClient2',
      Weird: 'Weird',
    });
    expect(names.modules.get('Foo.Bar')).toBe('foo_bar');
    expect(names.modules.get('String')).toBe('string2');
    expect(Object.fromEntries(names.members('Weird'))).toEqual({
      type: 'r#type',
      self: 'self_',
      crate: 'crate_',
      'x-foo': 'x_foo',
      '2fa': '_2fa',
      foo_bar: 'foo_bar',
      fooBar: 'foo_bar2',
      FooBar: 'foo_bar3',
      _: '__',
    });
  });

  it('keeps module names away from crates and the models module', () => {
    const names = buildNames(doc({ Core: obj([prop('a', str)]), Models: obj([prop('a', str)]), Mod: obj([prop('a', str)]) }), options(), []);
    expect([...names.modules.values()]).toEqual(['core2', 'models2', 'mod_']);
  });

  it('applies naming rules and hooks', () => {
    const ir = doc({ pet: obj([prop('petName', str)]) });
    const names = buildNames(
      ir,
      options({ naming: { type: { name: 'Api{{name}}' } }, hooks: { propertyName: (n) => (n === 'petName' ? 'label' : undefined), fileName: () => 'pet_model' } }),
      [],
    );
    expect(names.types.get('pet')).toBe('ApiPet');
    expect(names.modules.get('pet')).toBe('pet_model');
    expect(names.members('pet').get('petName')).toBe('label');
  });

  it('escapes keywords', () => {
    expect(['type', 'match', 'gen', 'self', 'Self', 'super', 'value'].map(escapeKeyword)).toEqual(['r#type', 'r#match', 'r#gen', 'self_', 'Self_', 'super_', 'value']);
  });

  it('derives the package name from the title', () => {
    expect(packageName(doc({}, [], { info: { title: 'Archon Edge Cases', version: '1' } }), options())).toBe('archon-edge-cases');
    expect(packageName(doc({}, [], { info: { title: '2nd API', version: '1' } }), options())).toBe('api-2nd-api');
    expect(packageName(doc({}, [], { info: { title: '!!!', version: '1' } }), options())).toBe('api');
    expect(packageName(doc({}), options({ package: { name: 'my-sdk' } }))).toBe('my-sdk');
  });
});

describe('rust plugin: emit', () => {
  it('keeps doc comments from becoming doctests', () => {
    const text = 'Example:\n\n```\nlet x = 1;\n```\n\n    indented code\n\n```json\n{"a": 1}\n```\n\n```rust\nfn x() {}\n```';
    expect(docLines(text)).toEqual([
      '/// Example:',
      '///',
      '/// ```text',
      '/// let x = 1;',
      '/// ```',
      '///',
      '/// indented code',
      '///',
      '/// ```json',
      '/// {"a": 1}',
      '/// ```',
      '///',
      '/// ```text',
      '/// fn x() {}',
      '/// ```',
    ]);
    expect(docLines('Unclosed\n```\ncode')).toEqual(['/// Unclosed', '/// ```text', '/// code', '/// ```']);
    expect(docLines('Crate docs', true)).toEqual(['//! Crate docs']);
    expect(docLines('  ')).toEqual([]);
  });

  it('writes Rust and TOML string literals', () => {
    expect(literal('a"b\\c\nd\t{}\u0001\ud800')).toBe('"a\\"b\\\\c\\nd\\t{}\\u{1}\\u{fffd}"');
    expect(tomlString('a"b\n\u007f')).toBe('"a\\"b\\n\\u007f"');
  });
});
