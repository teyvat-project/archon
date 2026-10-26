import { describe, expect, it } from 'vitest';
import { constant, resolveGemName, resolveModuleName, rubyIdentifier, screaming } from '../../../src/plugins/ruby/names.js';
import { doc, generate, model, obj, options, prop, str } from './helpers.js';

describe('ruby plugin: names', () => {
  it('derives the gem and module names from the title or the options', () => {
    const ir = doc({}, [], { info: { title: 'Archon Edge Cases', version: '1' } });
    expect(resolveGemName(ir, options())).toBe('archon_edge_cases');
    expect(resolveModuleName('archon_edge_cases', options())).toBe('ArchonEdgeCases');
    expect(resolveGemName(doc({}, [], { info: { title: '2nd API!', version: '1' } }), options())).toBe('api_2nd_api');
    expect(resolveGemName(doc({}, [], { info: { title: '日本', version: '1' } }), options())).toBe('api');
    expect(resolveModuleName('x', options({ moduleName: 'acme::api' }))).toBe('Acme::Api');
  });

  it('makes identifiers and constants valid, escaping keywords and Object methods', () => {
    expect(['class', 'end', 'method', 'hash', 'to_h', '2fa', 'x-foo', 'fooBar', '日本', 'URLValue'].map((n) => rubyIdentifier(n))).toEqual([
      'class_', 'end_', 'method_', 'hash_', 'to_h_', '_2fa', 'x_foo', 'foo_bar', 'value', 'url_value',
    ]);
    expect(['1Thing', 'thing', 'Thing'].map(constant)).toEqual(['X1Thing', 'Thing', 'Thing']);
    expect(['is-known', '', '1st'].map(screaming)).toEqual(['IS_KNOWN', 'VALUE', 'V_1ST']);
  });

  it('keeps schema constants clear of the module constants and member names unique', async () => {
    const { files } = await generate(
      doc({
        Client: obj([prop('a', str)]),
        Core: obj([prop('a', str)]),
        Weird: obj([prop('foo_bar', str), prop('fooBar', str), prop('class', str), prop('2fa', str, true)]),
      }),
    );
    expect(model(files, 'client2')).toContain('Client2 = ::Data.define(:a)');
    expect(model(files, 'core2')).toContain('Core2 = ::Data.define(:a)');
    const weird = model(files, 'weird');
    expect(weird).toContain('Weird = ::Data.define(:foo_bar, :foo_bar2, :class_, :_2fa)');
    expect(weird).toContain("Core::Field.new(name: :foo_bar2, wire: 'fooBar', type: Core::Types::STRING),");
    expect(weird).toContain('def initialize(foo_bar: nil, foo_bar2: nil, class_: nil, _2fa:)');
  });
});
