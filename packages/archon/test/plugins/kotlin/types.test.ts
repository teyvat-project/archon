import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../../src/diagnostics.js';
import type { IRSchema } from '../../../src/ir/types.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { KotlinPluginOptions } from '../../../src/plugins/kotlin/index.js';
import { buildNames } from '../../../src/plugins/kotlin/names.js';
import { KtTypeResolver } from '../../../src/plugins/kotlin/types.js';
import { arr, bin, bool, date, dateTime, doc, enumOf, int, nullable, num, obj, options, prop, ref, str, union } from './helpers.js';

function resolver(schemas: Record<string, IRSchema> = {}, opts: DeepPartial<KotlinPluginOptions> = {}) {
  const ir = doc(schemas);
  const o = options(opts);
  const diagnostics = new Diagnostics();
  return new KtTypeResolver(ir, buildNames(ir, o, []), o, diagnostics, 'test.api');
}

const t = (r: KtTypeResolver, s: IRSchema) => {
  const type = r.typeOf(s, ['x']);
  return [type.code, type.serializer];
};

describe('kotlin plugin: types', () => {
  it('maps formats and nullability', () => {
    const r = resolver();
    expect(t(r, str)).toEqual(['String', 'String.serializer()']);
    expect(t(r, dateTime)).toEqual(['String', 'String.serializer()']);
    expect(t(r, date)).toEqual(['String', 'String.serializer()']);
    expect(t(r, { kind: 'string', format: 'uuid', nullable: false })).toEqual(['String', 'String.serializer()']);
    expect(t(r, { kind: 'string', format: 'byte', nullable: false })).toEqual(['String', 'String.serializer()']);
    expect(t(r, int)).toEqual(['Int', 'Int.serializer()']);
    expect(t(r, { kind: 'integer', format: 'int64', nullable: false })).toEqual(['Long', 'Long.serializer()']);
    expect(t(r, num)).toEqual(['Double', 'Double.serializer()']);
    expect(t(r, { kind: 'number', format: 'float', nullable: false })).toEqual(['Float', 'Float.serializer()']);
    expect(t(r, bool)).toEqual(['Boolean', 'Boolean.serializer()']);
    expect(t(r, bin)).toEqual(['ApiFile', 'ApiFile.Serializer']);
    expect(t(r, { kind: 'unknown', nullable: false })).toEqual(['JsonElement', 'JsonElement.serializer()']);
    expect(t(r, { kind: 'null', nullable: true })).toEqual(['JsonElement', 'JsonElement.serializer()']);
    expect(t(r, { kind: 'tuple', items: [str], nullable: false })).toEqual(['JsonElement', 'JsonElement.serializer()']);
    expect(t(r, { kind: 'const', value: 'x', nullable: false })).toEqual(['String', 'String.serializer()']);
    expect(t(r, { kind: 'const', value: 1, nullable: false })).toEqual(['Long', 'Long.serializer()']);
    expect(t(r, { kind: 'const', value: 1.5, nullable: false })).toEqual(['Double', 'Double.serializer()']);
    expect(t(r, { kind: 'const', value: true, nullable: false })).toEqual(['Boolean', 'Boolean.serializer()']);
    expect(t(r, arr(str))).toEqual(['List<String>', 'ListSerializer(String.serializer())']);
    expect(t(r, arr(nullable(str)))).toEqual(['List<String?>', 'ListSerializer(String.serializer().nullable)']);
    expect(t(r, obj([], { additionalProperties: int }))).toEqual(['Map<String, Int>', 'MapSerializer(String.serializer(), Int.serializer())']);
    expect(t(r, obj([]))).toEqual(['JsonElement', 'JsonElement.serializer()']);

    const optional = r.nullable(r.typeOf(arr(str), ['x']));
    expect([optional.code, optional.serializer]).toEqual(['List<String>?', 'ListSerializer(String.serializer()).nullable']);
    expect(r.isNullable(nullable(str))).toBe(true);
    expect(r.isNullable(str)).toBe(false);
  });

  it('refers to declared schemas by name, with the serializer each kind provides', () => {
    const r = resolver({ Pet: obj([prop('a', str)]), Status: enumOf(['a']), Either: union([str, int]), Maybe: nullable(obj([prop('a', str)])) });
    expect(t(r, ref('Pet'))).toEqual(['Pet', 'Pet.serializer()']);
    expect(t(r, ref('Status'))).toEqual(['Status', 'Status.Serializer']);
    expect(t(r, ref('Either'))).toEqual(['Either', 'Either.Serializer']);
    expect(r.isNullable(ref('Maybe'))).toBe(true);
    const q = r.typeOf(arr(ref('Pet')), ['x'], { qualified: true });
    expect([q.code, q.serializer]).toEqual(['List<test.api.models.Pet>', 'ListSerializer(test.api.models.Pet.serializer())']);
  });

  it('expands non-object named schemas', () => {
    const r = resolver({ Ids: arr(str), Name: str });
    expect(t(r, ref('Ids'))).toEqual(['List<String>', 'ListSerializer(String.serializer())']);
    expect(t(r, ref('Name'))).toEqual(['String', 'String.serializer()']);
  });

  it('falls back to JsonElement on alias cycles', () => {
    const r = resolver({ A: arr(ref('A')) });
    expect(t(r, ref('A'))).toEqual(['List<JsonElement>', 'ListSerializer(JsonElement.serializer())']);
  });

  it('names wrapper-friendly types', () => {
    const r = resolver({ Cat: obj([prop('a', str)]) });
    expect(r.typeOf(str, ['x']).friendly).toBe('String');
    expect(r.typeOf(arr(ref('Cat')), ['x']).friendly).toBe('CatList');
    expect(r.typeOf(obj([], { additionalProperties: int }), ['x']).friendly).toBe('IntMap');
    expect(r.typeOf({ kind: 'unknown', nullable: false }, ['x']).friendly).toBe('Json');
  });

  it('applies typeMappings with and without serializer and typeOverride', () => {
    const r = resolver(
      {},
      {
        typeMappings: {
          integer: 'Long',
          'string:date-time': { type: 'kotlinx.datetime.Instant', serializer: 'kotlinx.datetime.serializers.InstantIso8601Serializer' },
        },
        hooks: { typeOverride: (s) => (s.kind === 'number' ? { type: 'java.math.BigDecimal', serializer: 'BigDecimalSerializer' } : undefined) },
      },
    );
    expect(t(r, int)).toEqual(['Long', 'Long.serializer()']);
    expect(t(r, dateTime)).toEqual(['kotlinx.datetime.Instant', 'kotlinx.datetime.serializers.InstantIso8601Serializer']);
    expect(r.typeOf(dateTime, ['x']).friendly).toBe('Instant');
    expect(t(r, num)).toEqual(['java.math.BigDecimal', 'BigDecimalSerializer']);
    expect(t(r, str)).toEqual(['String', 'String.serializer()']);
  });
});
