import { describe, expect, it } from 'vitest';
import type { IRSchema } from '../../../src/ir/types.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import { buildNames } from '../../../src/plugins/csharp/names.js';
import { CsTypeResolver } from '../../../src/plugins/csharp/types.js';
import { arr, bin, date, dateTime, doc, G, GEN, int, num, obj, options, prop, ref, STJ, str } from './helpers.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { CSharpPluginOptions } from '../../../src/plugins/csharp/index.js';

function resolver(schemas: Record<string, IRSchema> = {}, opts: DeepPartial<CSharpPluginOptions> = {}) {
  const ir = doc(schemas);
  const o = options({ namespace: 'Test.Api', ...opts });
  return new CsTypeResolver(ir, buildNames(ir, o, []), o, new Diagnostics());
}

const code = (r: CsTypeResolver, s: IRSchema, usage: 'model' | 'parameter' = 'model') => r.typeOf(s, ['x'], usage).code;

describe('csharp plugin: types', () => {
  it('maps formats and kinds', () => {
    const r = resolver();
    expect(code(r, str)).toBe('string');
    expect(code(r, dateTime)).toBe(`${G}.DateTimeOffset`);
    expect(code(r, date)).toBe(`${G}.DateOnly`);
    expect(code(r, { kind: 'string', format: 'time', nullable: false })).toBe(`${G}.TimeOnly`);
    expect(code(r, { kind: 'string', format: 'uuid', nullable: false })).toBe(`${G}.Guid`);
    expect(code(r, { kind: 'string', format: 'byte', nullable: false })).toBe('byte[]');
    expect(code(r, { kind: 'string', format: 'uri', nullable: false })).toBe('string');
    expect(code(r, int)).toBe('int');
    expect(code(r, { kind: 'integer', format: 'int64', nullable: false })).toBe('long');
    expect(code(r, num)).toBe('double');
    expect(code(r, { kind: 'number', format: 'float', nullable: false })).toBe('float');
    expect(code(r, { kind: 'boolean', nullable: false })).toBe('bool');
    expect(code(r, bin)).toBe('global::Test.Api.Core.ApiFile');
    expect(code(r, { kind: 'unknown', nullable: false })).toBe(`${STJ}.JsonElement`);
    expect(code(r, { kind: 'const', value: 'x', nullable: false })).toBe('string');
    expect(code(r, arr(str))).toBe(`${GEN}.List<string>`);
    expect(code(r, obj([], { additionalProperties: int }))).toBe(`${GEN}.Dictionary<string, int>`);
    expect(code(r, obj([]))).toBe(`${GEN}.Dictionary<string, ${STJ}.JsonElement>`);
  });

  it('reports value types and nullable code', () => {
    const r = resolver();
    const t = r.typeOf(int, ['x'], 'model');
    expect(t.valueType).toBe(true);
    expect(r.nullableCode(t, true)).toBe('int?');
    expect(r.nullableCode(r.typeOf(str, ['x'], 'model'), true)).toBe('string?');
    expect(r.nullableCode(r.typeOf(str, ['x'], 'model'), false)).toBe('string');
  });

  it('expands non-object named schemas', () => {
    const r = resolver({ Ids: arr(str), Pet: obj([prop('a', str)]) });
    expect(code(r, ref('Ids'))).toBe(`${GEN}.List<string>`);
    expect(code(r, ref('Pet'))).toBe('Pet');
  });

  it('falls back to JsonElement on alias cycles', () => {
    const r = resolver({ A: arr(ref('A')) });
    expect(code(r, ref('A'))).toBe(`${GEN}.List<${STJ}.JsonElement>`);
  });

  it('applies typeMappings and typeOverride', () => {
    const r = resolver({}, {
      typeMappings: { 'string:uuid': 'string', integer: 'long' },
      hooks: { typeOverride: (s) => (s.kind === 'number' ? 'decimal' : undefined) },
    });
    expect(code(r, { kind: 'string', format: 'uuid', nullable: false })).toBe('string');
    expect(code(r, int)).toBe('long');
    expect(r.typeOf(int, ['x'], 'model').valueType).toBe(true);
    expect(code(r, num)).toBe('decimal');
  });

  it('uses IReadOnlyList for parameters', () => {
    expect(code(resolver(), arr(arr(str)), 'parameter')).toBe(`${GEN}.IReadOnlyList<${GEN}.List<string>>`);
  });

  it('registers types for the JSON context with stable names', () => {
    const r = resolver({ Pet: obj([prop('a', str)]) });
    expect(r.register(r.typeOf(arr(str), ['x'], 'model'))).toBe('ListOfString');
    expect(r.register(r.typeOf(int, ['x'], 'model'), true)).toBe('NullableInt32');
    expect(r.register(r.typeOf(ref('Pet'), ['x'], 'model'))).toBe('Pet');
    expect(r.register(r.typeOf(arr(str), ['y'], 'parameter'))).toBe('IReadOnlyListOfString');
    expect(r.register(r.typeOf(obj([], { additionalProperties: dateTime }), ['x'], 'model'))).toBe('DictionaryOfStringDateTimeOffset');
    // registering again returns the same name
    expect(r.register(r.typeOf(arr(str), ['z'], 'model'))).toBe('ListOfString');
    expect(r.registered().map((e) => e.property)).toEqual([
      'ListOfString',
      'NullableInt32',
      'Pet',
      'IReadOnlyListOfString',
      'DictionaryOfStringDateTimeOffset',
    ]);
  });
});
