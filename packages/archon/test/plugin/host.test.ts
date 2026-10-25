import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.js';
import type { ResolvedConfig } from '../../src/config/types.js';
import { ArchonError, Diagnostics } from '../../src/diagnostics.js';
import type { IRDocument, IRSchema } from '../../src/ir/types.js';
import { definePlugin } from '../../src/plugin/define.js';
import { runPlugins } from '../../src/plugin/host.js';
import type { ArchonPlugin } from '../../src/plugin/types.js';

const inlineObject: IRSchema = {
  kind: 'object',
  nullable: false,
  properties: [{ name: 'x', required: true, schema: { kind: 'string', nullable: false } }],
};

function doc(): IRDocument {
  return {
    info: { title: 't', version: '1' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map<string, IRSchema>([
      [
        'Pet',
        {
          kind: 'object',
          nullable: false,
          properties: [{ name: 'owner', required: true, schema: inlineObject }],
        },
      ],
    ]),
    operations: [],
  };
}

// plugins は各テストで差し替える
function config(plugins: ArchonPlugin<any, any>[], extra: Partial<ResolvedConfig['output']> = {}): ResolvedConfig {
  const base = resolveConfig({ input: 'spec.yaml', output: 'out', plugins }, { cwd: '/proj' });
  return { ...base, output: { ...base.output, ...extra } };
}

async function run(plugins: ArchonPlugin<any, any>[], opts?: { only?: string[] }, ir: IRDocument = doc()) {
  return (await runPlugins(ir, config(plugins), new Diagnostics(), opts)).files;
}

function runDirs(plugins: ArchonPlugin<any, any>[], opts?: { only?: string[] }) {
  return runPlugins(doc(), config(plugins), new Diagnostics(), opts).then((r) => r.outputDirs);
}

const emitter = (name: string, log?: string[], extra: Record<string, unknown> = {}) =>
  definePlugin<{ output?: string }, void>({
    name,
    defaults: {},
    generate(ctx) {
      log?.push(name);
      ctx.emit('a.txt', name);
    },
    ...extra,
  });

describe('runPlugins', () => {
  it('runs plugins in dependency order', async () => {
    const log: string[] = [];
    const a = emitter('a', log, { dependencies: ['b'] });
    const b = emitter('b', log, { dependencies: ['c'] });
    const c = emitter('c', log);
    const files = await run([a(), b(), c()]);
    expect(log).toEqual(['c', 'b', 'a']);
    expect(files.map((f) => f.path)).toEqual(['c/a.txt', 'b/a.txt', 'a/a.txt']);
  });

  it('keeps registration order when there are no dependencies', async () => {
    const log: string[] = [];
    await run([emitter('x', log)(), emitter('y', log)(), emitter('z', log)()]);
    expect(log).toEqual(['x', 'y', 'z']);
  });

  it('auto-adds missing dependency via factories', async () => {
    const log: string[] = [];
    const base = emitter('base', log);
    const top = emitter('top', log, { dependencies: ['base'], factories: { base } });
    const files = await run([top()]);
    expect(log).toEqual(['base', 'top']);
    expect(files.map((f) => f.path).sort()).toEqual(['base/a.txt', 'top/a.txt']);
  });

  it('fails when a dependency is missing and has no factory', async () => {
    const top = emitter('top', [], { dependencies: ['nope'] });
    await expect(run([top()])).rejects.toMatchObject({ code: 'plugin-missing-dependency' });
  });

  it('fails on dependency cycle', async () => {
    const a = emitter('a', [], { dependencies: ['b'] });
    const b = emitter('b', [], { dependencies: ['a'] });
    const err = await run([a(), b()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchonError);
    expect(err).toMatchObject({ code: 'plugin-cycle' });
  });

  it('fails on duplicate plugin names', async () => {
    await expect(run([emitter('a')(), emitter('a')()])).rejects.toMatchObject({ code: 'plugin-duplicate' });
  });

  it('plugin() returns dependency API', async () => {
    const dep = definePlugin<Record<string, never>, { greeting: string }>({
      name: 'dep',
      defaults: {},
      generate: () => ({ greeting: 'hello' }),
    });
    let seen: unknown;
    const top = definePlugin<Record<string, never>, void>({
      name: 'top',
      defaults: {},
      dependencies: ['dep'],
      generate(ctx) {
        seen = ctx.plugin<{ greeting: string }>('dep');
      },
    });
    await run([top(), dep()]);
    expect(seen).toEqual({ greeting: 'hello' });
  });

  it('plugin() fails for a plugin that has not run', async () => {
    const later = emitter('later');
    const early = definePlugin<Record<string, never>, void>({
      name: 'early',
      defaults: {},
      generate(ctx) {
        ctx.plugin('later');
      },
    });
    await expect(run([early(), later()])).rejects.toMatchObject({ code: 'plugin-not-ready' });
  });

  it('plugin receives hoisted IR only when it requested', async () => {
    const seen: Record<string, string[]> = {};
    const mk = (name: string, req?: { hoistInlineObjects: boolean }) =>
      definePlugin<Record<string, never>, void>({
        name,
        defaults: {},
        ...(req ? { irRequirements: () => req } : {}),
        generate(ctx) {
          seen[name] = [...ctx.ir.schemas.keys()];
        },
      });
    const ir = doc();
    await run([mk('plain')(), mk('hoisting', { hoistInlineObjects: true })()], undefined, ir);
    expect(seen['plain']).toEqual(['Pet']);
    expect(seen['hoisting']).toEqual(['Pet', 'PetOwner']);
    // caller's IR is untouched
    expect([...ir.schemas.keys()]).toEqual(['Pet']);
  });

  it('transformIR mutations are visible to all plugins', async () => {
    const seen: string[][] = [];
    const transformer = definePlugin<Record<string, never>, void>({
      name: 'transformer',
      defaults: {},
      transformIR(ir) {
        ir.schemas.set('Added', { kind: 'string', nullable: false });
      },
      generate: () => {},
    });
    const reader = definePlugin<Record<string, never>, void>({
      name: 'reader',
      defaults: {},
      generate(ctx) {
        seen.push([...ctx.ir.schemas.keys()]);
      },
    });
    // reader is registered (and runs) before transformer, but transformIR is applied to all first
    await run([reader(), transformer()]);
    expect(seen).toEqual([['Pet', 'Added']]);
  });

  it('duplicate emit path fails', async () => {
    const p = definePlugin<Record<string, never>, void>({
      name: 'dup',
      defaults: {},
      generate(ctx) {
        ctx.emit('a.txt', '1');
        ctx.emit('./a.txt', '2');
      },
    });
    await expect(run([p()])).rejects.toMatchObject({ code: 'duplicate-output' });
  });

  it('two plugins emitting into the same directory and path collide', async () => {
    const a = emitter('a')({ output: 'shared' });
    const b = emitter('b')({ output: 'shared' });
    await expect(run([a, b])).rejects.toMatchObject({ code: 'duplicate-output' });
  });

  it('uses options.output as outputDir, and "." means the output root', async () => {
    const files = await run([emitter('a')({ output: 'custom/dir' }), emitter('b')({ output: '.' })]);
    expect(files.map((f) => f.path)).toEqual(['custom/dir/a.txt', 'a.txt']);
  });

  it('rejects emit paths escaping the output dir', async () => {
    const p = definePlugin<Record<string, never>, void>({
      name: 'esc',
      defaults: {},
      generate: (ctx) => ctx.emit('../evil.txt', 'x'),
    });
    await expect(run([p()])).rejects.toMatchObject({ code: 'invalid-output-path' });
  });

  it('exposes options, outputDir, headerLines and writer on the context', async () => {
    let seen: { outputDir: string; header: string[]; custom: string[]; text: string; opt: number } | undefined;
    const p = definePlugin<{ n: number; output?: string }, void>({
      name: 'ctx',
      defaults: { n: 1 },
      generate(ctx) {
        seen = {
          outputDir: ctx.outputDir,
          header: ctx.headerLines('typescript'),
          custom: [],
          text: ctx.writer({ indent: '\t' }).block('x {', () => {}).toString(),
          opt: ctx.options.n,
        };
      },
    });
    const cfg = config([p({ n: 5 })], { header: ({ defaultValue, language }) => [...defaultValue, `lang=${language}`] });
    await runPlugins(doc(), cfg, new Diagnostics());
    expect(seen?.outputDir).toBe('ctx');
    expect(seen?.opt).toBe(5);
    expect(seen?.header).toEqual(['This file was generated by Archon. Do not edit manually.', 'lang=typescript']);
    expect(seen?.text).toBe('x {\n}\n');
  });

  it('only restricts which plugins run (plus their dependencies)', async () => {
    const log: string[] = [];
    const dep = emitter('dep', log);
    const a = emitter('a', log, { dependencies: ['dep'] });
    const b = emitter('b', log);
    await run([a(), dep(), b()], { only: ['a'] });
    expect(log).toEqual(['dep', 'a']);
    await expect(run([a(), dep()], { only: ['zzz'] })).rejects.toMatchObject({ code: 'plugin-unknown' });
  });

  it('reports deduplicated outputDirs including auto-added dependencies and silent plugins', async () => {
    const base = emitter('base');
    const top = emitter('top', [], { dependencies: ['base'], factories: { base } });
    const silent = definePlugin<{ output?: string }, void>({ name: 'silent', defaults: {}, generate: () => {} });
    expect(await runDirs([top(), silent()])).toEqual(['base', 'top', 'silent']);
    expect(await runDirs([emitter('a')({ output: 'shared' }), silent({ output: 'shared' })])).toEqual(['shared']);
    expect(await runDirs([emitter('a')({ output: 'x/' }), emitter('b')({ output: '.' })])).toEqual(['x', '.']);
  });

  it('outputDirs respects only', async () => {
    const dep = emitter('dep');
    const a = emitter('a', [], { dependencies: ['dep'] });
    const b = emitter('b');
    expect(await runDirs([a(), dep(), b()], { only: ['a'] })).toEqual(['dep', 'a']);
  });

  it('fails when a factory returns a plugin with a different name', async () => {
    const wrong = emitter('other');
    const top = emitter('top', [], { dependencies: ['base'], factories: { base: wrong } });
    await expect(run([top()])).rejects.toMatchObject({ code: 'plugin-missing-dependency' });
  });

  it('passes inlineSchemaName hook to hoisting', async () => {
    const seen: string[][] = [];
    const p = definePlugin<Record<string, never>, void>({
      name: 'h',
      defaults: {},
      irRequirements: () => ({ hoistInlineObjects: true }),
      generate: (ctx) => void seen.push([...ctx.ir.schemas.keys()]),
    });
    const base = config([p()]);
    const cfg: ResolvedConfig = {
      ...base,
      parser: { hooks: { inlineSchemaName: () => 'Custom' } },
    };
    await runPlugins(doc(), cfg, new Diagnostics());
    expect(seen).toEqual([['Pet', 'Custom']]);
  });
});

describe('definePlugin', () => {
  it('deep merges plain objects, replaces arrays/functions/primitives', () => {
    const fn1 = () => 1;
    const fn2 = () => 2;
    const p = definePlugin<{ a: { b: number; c: number }; list: string[]; fn: () => number; s: string }, void>({
      name: 'm',
      defaults: { a: { b: 1, c: 2 }, list: ['x', 'y'], fn: fn1, s: 'd' },
      generate: () => {},
    });
    const r = p({ a: { b: 9 }, list: ['z'], fn: fn2 });
    expect(r.name).toBe('m');
    expect(r.options).toEqual({ a: { b: 9, c: 2 }, list: ['z'], fn: fn2, s: 'd' });
    expect(r.definition.name).toBe('m');
  });

  it('does not mutate defaults and ignores undefined overrides', () => {
    const defaults = { a: { b: 1 }, s: 'd' };
    const p = definePlugin<{ a: { b: number }; s: string }, void>({ name: 'm', defaults, generate: () => {} });
    const r = p({ a: { b: 2 }, s: undefined });
    expect(r.options).toEqual({ a: { b: 2 }, s: 'd' });
    expect(defaults).toEqual({ a: { b: 1 }, s: 'd' });
    expect(p().options).toEqual(defaults);
    expect(p().options.a).not.toBe(defaults.a);
  });

  it('replaces class instances', () => {
    class Foo {
      x = 1;
    }
    const p = definePlugin<{ foo: Foo }, void>({ name: 'm', defaults: { foo: new Foo() }, generate: () => {} });
    const foo = new Foo();
    expect(p({ foo }).options.foo).toBe(foo);
  });
});
