import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/config/resolve.js';
import { ArchonError, Diagnostics } from '../../../src/diagnostics.js';
import type { IRDocument, IRProperty, IRSchema } from '../../../src/ir/types.js';
import type { OpenAPIDocument } from '../../../src/loader/load.js';
import { parseDocument } from '../../../src/parser/index.js';
import { runCommonPasses, runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';
import { typescript } from '../../../src/plugins.js';
import type { TypeScriptPluginAPI, TypeScriptPluginOptions } from '../../../src/plugins/typescript/index.js';
import { buildTypeNameTable, renderTypes, schemaToTs } from '../../../src/plugins/typescript/types.js';

// ---- IR builders ----
const str: IRSchema = { kind: 'string', nullable: false };
const int: IRSchema = { kind: 'integer', nullable: false };
const nullable = (s: IRSchema): IRSchema => ({ ...s, nullable: true });
const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
const arr = (items: IRSchema): IRSchema => ({ kind: 'array', items, nullable: false });
const prop = (name: string, schema: IRSchema, required = false): IRProperty => ({ name, schema, required });
const obj = (properties: IRProperty[], extra: Partial<Extract<IRSchema, { kind: 'object' }>> = {}): IRSchema => ({
  kind: 'object',
  nullable: false,
  properties,
  ...extra,
});
const strEnum = (...values: string[]): IRSchema => ({ kind: 'enum', base: 'string', values, nullable: false });

function doc(schemas: [string, IRSchema][]): IRDocument {
  return {
    info: { title: 'Test API', version: '1.0.0' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map(schemas),
    operations: [],
  };
}

function options(opts: DeepPartial<TypeScriptPluginOptions> = {}): TypeScriptPluginOptions {
  return typescript(opts).options;
}

function fakeCtx(ir: IRDocument, opts: TypeScriptPluginOptions, emitted: EmittedFile[] = []): PluginContext<TypeScriptPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'typescript',
    diagnostics: new Diagnostics(),
    emit: (path, content) => void emitted.push({ path, content }),
    headerLines: () => ['Generated header'],
    writer: (o) => new CodeWriter(o),
    plugin: () => {
      throw new Error('no dependencies');
    },
  };
}

function render(schemas: [string, IRSchema][], opts: DeepPartial<TypeScriptPluginOptions> = {}): string {
  const ir = doc(schemas);
  const o = options(opts);
  return renderTypes(fakeCtx(ir, o), buildTypeNameTable(ir, o));
}

async function generate(ir: IRDocument, opts: DeepPartial<TypeScriptPluginOptions> = {}) {
  const plugin = typescript(opts);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const api = (await plugin.definition.generate(fakeCtx(pluginIR, plugin.options, emitted))) as TypeScriptPluginAPI;
  return { api, emitted };
}

describe('typescript plugin: types.gen.ts', () => {
  it('declares irRequirements per enums option', () => {
    const req = (enums: TypeScriptPluginOptions['enums']) => {
      const p = typescript({ enums });
      return p.definition.irRequirements?.(p.options);
    };
    expect(req('union')).toEqual({ hoistInlineObjects: false, hoistInlineEnums: false });
    expect(req('const')).toEqual({ hoistInlineObjects: false, hoistInlineEnums: true });
    expect(req('enum')).toEqual({ hoistInlineObjects: false, hoistInlineEnums: true });
  });

  it('starts the file with the header lines as line comments', () => {
    expect(render([['Pet', str]]).startsWith('// Generated header\n\nexport type Pet = string;\n')).toBe(true);
  });

  it('renders object with optional and nullable properties', () => {
    const out = render([['Pet', obj([prop('id', int, true), prop('name', nullable(str))])]]);
    expect(out).toContain('export type Pet = {\n  id: number;\n  name?: string | null;\n};');
  });

  it('renders nested objects with deeper indentation', () => {
    const out = render([['Pet', obj([prop('owner', obj([prop('name', str, true)]), true)])]]);
    expect(out).toContain('export type Pet = {\n  owner: {\n    name: string;\n  };\n};');
  });

  it('renders union of refs and nullable array', () => {
    const out = render([
      ['Cat', obj([])],
      ['Dog', obj([])],
      ['Pet', { kind: 'union', nullable: false, variants: [ref('Cat'), ref('Dog')] }],
      ['Pets', nullable(arr(ref('Pet')))],
      ['Mixed', arr({ kind: 'union', nullable: false, variants: [str, int] })],
      ['Both', arr({ kind: 'intersection', nullable: false, members: [ref('Cat'), ref('Dog')] })],
      ['NullableItems', arr(nullable(str))],
    ]);
    expect(out).toContain('export type Pet = Cat | Dog;');
    expect(out).toContain('export type Pets = Pet[] | null;');
    expect(out).toContain('export type Mixed = (string | number)[];');
    expect(out).toContain('export type Both = (Cat & Dog)[];');
    expect(out).toContain('export type NullableItems = (string | null)[];');
  });

  it('renders discriminated unions as plain unions', () => {
    const out = render([
      ['A', obj([prop('type', strEnum('a'), true)])],
      ['B', obj([prop('type', strEnum('b'), true)])],
      [
        'Pair',
        {
          kind: 'union',
          nullable: false,
          variants: [ref('A'), ref('B')],
          discriminator: { property: 'type', mapping: new Map([['a', 'A'], ['b', 'B']]) },
        },
      ],
    ]);
    expect(out).toContain("export type A = {\n  type: 'a';\n};");
    expect(out).toContain('export type Pair = A | B;');
  });

  it('renders scalars, tuples, intersections, consts, binary and unknown', () => {
    const out = render([
      ['Num', { kind: 'number', nullable: false }],
      ['Bool', { kind: 'boolean', nullable: false }],
      ['Nil', { kind: 'null', nullable: false }],
      ['Tup', { kind: 'tuple', nullable: false, items: [str, int], rest: { kind: 'union', nullable: false, variants: [str, int] } }],
      ['Both', { kind: 'intersection', nullable: false, members: [ref('Num'), { kind: 'union', nullable: false, variants: [str, int] }] }],
      ['ConstStr', { kind: 'const', nullable: false, value: "it's" }],
      ['ConstNum', { kind: 'const', nullable: false, value: -1 }],
      ['ConstBool', { kind: 'const', nullable: false, value: true }],
      ['File', { kind: 'binary', nullable: false }],
      ['Any', { kind: 'unknown', nullable: true }],
      ['NumEnum', { kind: 'enum', base: 'integer', values: [1, 2], nullable: true }],
      ['Empty', { kind: 'union', nullable: false, variants: [] }],
    ]);
    expect(out).toContain('export type Num = number;');
    expect(out).toContain('export type Bool = boolean;');
    expect(out).toContain('export type Nil = null;');
    expect(out).toContain('export type Tup = [string, number, ...(string | number)[]];');
    expect(out).toContain('export type Both = Num & (string | number);');
    expect(out).toContain("export type ConstStr = 'it\\'s';");
    expect(out).toContain('export type ConstNum = -1;');
    expect(out).toContain('export type ConstBool = true;');
    expect(out).toContain('export type File = Blob;');
    expect(out).toContain('export type Any = unknown;');
    expect(out).toContain('export type NumEnum = 1 | 2 | null;');
    expect(out).toContain('export type Empty = never;');
  });

  it('renders empty objects and additionalProperties', () => {
    const out = render([
      ['Empty', obj([])],
      ['Closed', obj([], { additionalProperties: false })],
      ['Dict', obj([], { additionalProperties: int })],
      ['Bag', obj([], { additionalProperties: { kind: 'unknown', nullable: false } })],
      ['Compatible', obj([prop('a', int, true)], { additionalProperties: int })],
      ['Incompatible', obj([prop('a', str, true)], { additionalProperties: int })],
      ['OptionalProp', obj([prop('a', int)], { additionalProperties: int })],
    ]);
    expect(out).toContain('export type Empty = {};');
    expect(out).toContain('export type Closed = {};');
    expect(out).toContain('export type Dict = { [key: string]: number };');
    expect(out).toContain('export type Bag = { [key: string]: unknown };');
    expect(out).toContain('export type Compatible = {\n  a: number;\n  [key: string]: number;\n};');
    expect(out).toContain('export type Incompatible = {\n  a: string;\n  [key: string]: unknown;\n};');
    expect(out).toContain('export type OptionalProp = {\n  a?: number;\n  [key: string]: unknown;\n};');
  });

  it('renders enums as union / const / enum per option', () => {
    const schemas: [string, IRSchema][] = [
      ['Status', strEnum('active', 'in-active')],
      ['Level', { kind: 'enum', base: 'integer', values: [1, 2, -3], nullable: false }],
      ['Pet', obj([prop('kind', strEnum('cat', 'dog'), true)])],
    ];

    const union = render(schemas);
    expect(union).toContain("export type Status = 'active' | 'in-active';");
    expect(union).toContain('export type Level = 1 | 2 | -3;');

    const asConst = render(schemas, { enums: 'const' });
    expect(asConst).toContain(
      "export const Status = {\n  Active: 'active',\n  InActive: 'in-active',\n} as const;\nexport type Status = typeof Status[keyof typeof Status];",
    );
    expect(asConst).toContain('export const Level = {\n  _1: 1,\n  _2: 2,\n  Minus3: -3,\n} as const;');
    // inline enum はリテラル union のまま
    expect(asConst).toContain("export type Pet = {\n  kind: 'cat' | 'dog';\n};");

    const asEnum = render(schemas, { enums: 'enum' });
    expect(asEnum).toContain("export enum Status {\n  Active = 'active',\n  InActive = 'in-active',\n}");
    expect(asEnum).toContain('export enum Level {\n  _1 = 1,\n  _2 = 2,\n  Minus3 = -3,\n}');
    expect(asEnum).toContain("export type Pet = {\n  kind: 'cat' | 'dog';\n};");
  });

  it('resolves colliding enum member names with numeric suffixes', () => {
    const out = render([['E', strEnum('a-b', 'a_b', '')]], { enums: 'enum' });
    expect(out).toContain("export enum E {\n  AB = 'a-b',\n  AB2 = 'a_b',\n  Empty = '',\n}");
  });

  it('keeps nullability of named enums in const style and falls back to a union in enum style', () => {
    const schemas: [string, IRSchema][] = [['Status', nullable(strEnum('a'))]];
    expect(render(schemas, { enums: 'const' })).toContain(
      'export type Status = typeof Status[keyof typeof Status] | null;',
    );
    expect(render(schemas, { enums: 'enum' })).toContain("export type Status = 'a' | null;");
  });

  it('quotes invalid property identifiers and sanitizes type names', () => {
    const out = render([
      ['Foo.Bar', obj([prop('x-foo', str, true), prop('2fa', str), prop('with space', str), prop("it's", str), prop('$ok_1', str)])],
      ['1Thing', obj([])],
      ['foo-bar', obj([])],
      ['Holder', obj([prop('a', ref('foo-bar'), true), prop('b', ref('1Thing'), true)])],
    ]);
    expect(out).toContain(
      "export type FooBar = {\n  'x-foo': string;\n  '2fa'?: string;\n  'with space'?: string;\n  'it\\'s'?: string;\n  $ok_1?: string;\n};",
    );
    expect(out).toContain('export type _1Thing = {};');
    expect(out).toContain('export type FooBar2 = {};');
    expect(out).toContain('export type Holder = {\n  a: FooBar2;\n  b: _1Thing;\n};');
  });

  it('suffixes TS reserved words and applies naming rules and the typeName hook', () => {
    const ir = doc([
      ['string', str],
      ['delete', str],
      ['Date', str],
      ['pet', str],
      ['Hooked', str],
    ]);
    const names = buildTypeNameTable(ir, options({ naming: { type: { case: 'preserve' } } }));
    expect(names.get('string')).toBe('string_');
    expect(names.get('delete')).toBe('delete_');
    expect(names.get('Date')).toBe('Date_');

    const templated = buildTypeNameTable(
      ir,
      options({
        naming: { type: { name: 'I{{name}}' } },
        hooks: { typeName: (n) => (n === 'Hooked' ? 'Custom' : undefined) },
      }),
    );
    expect(templated.get('pet')).toBe('IPet');
    expect(templated.get('Hooked')).toBe('Custom');
  });

  it('renders self-referencing schema by name', () => {
    const out = render([
      ['Comment', obj([prop('replies', arr(ref('Comment')))])],
      ['A', obj([prop('b', ref('B'))])],
      ['B', obj([prop('a', ref('A'))])],
    ]);
    expect(out).toContain('export type Comment = {\n  replies?: Comment[];\n};');
    expect(out).toContain('export type A = {\n  b?: B;\n};');
    expect(out).toContain('export type B = {\n  a?: A;\n};');
  });

  it('applies typeMappings and typeOverride', () => {
    const uuid: IRSchema = { kind: 'string', format: 'uuid', nullable: false };
    const seen: string[][] = [];
    const out = render(
      [
        ['Id', uuid],
        ['NullableId', nullable(uuid)],
        ['Ids', arr(uuid)],
        ['Holder', obj([prop('secret', str, true), prop('id', uuid, true)])],
      ],
      {
        typeMappings: { 'string:uuid': 'Uuid | string' },
        hooks: {
          typeOverride: (schema, ctx) => {
            seen.push(ctx.path);
            return ctx.path.join('.') === 'schemas.Holder.properties.secret' ? 'Secret' : undefined;
          },
        },
      },
    );
    expect(out).toContain('export type Id = Uuid | string;');
    expect(out).toContain('export type NullableId = Uuid | string | null;');
    expect(out).toContain('export type Ids = (Uuid | string)[];');
    expect(out).toContain('export type Holder = {\n  secret: Secret;\n  id: Uuid | string;\n};');
    expect(seen).toContainEqual(['schemas', 'Ids', 'items']);
  });

  it('maps date-time to Date when dates=Date', () => {
    const schemas: [string, IRSchema][] = [
      ['At', { kind: 'string', format: 'date-time', nullable: false }],
      ['On', { kind: 'string', format: 'date', nullable: true }],
    ];
    expect(render(schemas)).toContain('export type At = string;');
    const out = render(schemas, { dates: 'Date' });
    expect(out).toContain('export type At = Date;');
    expect(out).toContain('export type On = Date | null;');
  });

  it('emits JSDoc with @deprecated', () => {
    const out = render([
      [
        'Pet',
        {
          ...obj([prop('name', { ...str, description: 'The name */ here', deprecated: true }, true)]),
          description: 'A pet.\nSecond line.',
          deprecated: true,
        },
      ],
    ]);
    expect(out).toContain(
      '/**\n * A pet.\n * Second line.\n * @deprecated\n */\nexport type Pet = {\n  /**\n   * The name *\\/ here\n   * @deprecated\n   */\n  name: string;\n};',
    );
  });

  it('schemaToTs renders a standalone schema', () => {
    const ir = doc([['Pet', obj([])]]);
    const o = options();
    expect(schemaToTs(arr(ref('Pet')), buildTypeNameTable(ir, o), o, ['x'])).toBe('Pet[]');
  });

  it('emits types.gen.ts and exposes symbols', async () => {
    const { api, emitted } = await generate(doc([['foo-bar', obj([])], ['Foo.Bar', obj([])]]));
    expect(emitted[0]?.path).toBe('types.gen.ts');
    expect(api.symbols.typeOf('foo-bar')).toEqual({ name: 'FooBar', file: 'types.gen.ts' });
    expect(api.symbols.typeOf('Foo.Bar')).toEqual({ name: 'FooBar2', file: 'types.gen.ts' });
    expect(() => api.symbols.typeOf('Missing')).toThrow(ArchonError);
  });

  it('symbols.typeOf returns sanitized name', async () => {
    const { api } = await generate(doc([['1Thing', obj([])], ['class', obj([])]]), { naming: { type: { case: 'preserve' } } });
    expect(api.symbols.typeOf('1Thing').name).toBe('_1Thing');
    expect(api.symbols.typeOf('class').name).toBe('class_');
  });

  it('hoists inline enums into named declarations when enums is not union', async () => {
    const { emitted } = await generate(doc([['Pet', obj([prop('kind', strEnum('cat'), true)])]]), { enums: 'enum' });
    const content = String(emitted[0]?.content);
    expect(content).toContain("export enum PetKind {\n  Cat = 'cat',\n}");
    expect(content).toContain('export type Pet = {\n  kind: PetKind;\n};');
  });

  it('compiles the natsuneko types with tsc --strict', async () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../../../fixtures/specs/natsuneko.json', import.meta.url), 'utf8'),
    ) as OpenAPIDocument;
    const dir = mkdtempSync(join(tmpdir(), 'archon-ts-types-'));
    try {
      const variants: DeepPartial<TypeScriptPluginOptions>[] = [{}, { enums: 'const' }, { enums: 'enum', dates: 'Date' }];
      const files: string[] = [];
      for (const [i, opts] of variants.entries()) {
        const diagnostics = new Diagnostics();
        const ir = parseDocument(raw, { diagnostics });
        runCommonPasses(ir, {}, diagnostics);
        const { emitted } = await generate(ir, opts);
        const file = join(dir, `types${i}.gen.ts`);
        writeFileSync(file, String(emitted[0]?.content));
        files.push(file);
      }
      const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
      const result = spawnSync(
        tsc,
        ['--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM', ...files],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(result.stdout + result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
