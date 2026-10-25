import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.js';
import { Diagnostics } from '../../src/diagnostics.js';

const root = resolve('/proj/cfg');

describe('resolveConfig', () => {
  it('resolves output string shorthand and defaults', () => {
    const r = resolveConfig({ input: 'spec.yaml', output: 'gen' }, { cwd: root });
    expect(r.output.path).toBe(resolve(root, 'gen'));
    expect(r.output.clean).toBe(true);
    expect(r.output.postProcess).toEqual([]);
    expect(r.output.header({ defaultValue: ['a', 'b'], language: 'ts' })).toEqual(['a', 'b']);
    expect(r.plugins).toEqual([]);
    expect(r.parser).toEqual({});
    expect(r.root).toBe(root);
  });

  it('keeps explicit output options', () => {
    const header = () => ['x'];
    const r = resolveConfig(
      {
        input: 'spec.yaml',
        output: { path: 'gen', clean: false, header, postProcess: [{ command: 'prettier', args: ['--write'] }] },
      },
      { cwd: root },
    );
    expect(r.output.clean).toBe(false);
    expect(r.output.header).toBe(header);
    expect(r.output.postProcess).toEqual([{ command: 'prettier', args: ['--write'] }]);
  });

  it('resolves relative paths against config dir', () => {
    expect(resolveConfig({ input: 'spec.yaml', output: 'gen' }, { cwd: root }).input).toBe(resolve(root, 'spec.yaml'));
    expect(resolveConfig({ input: { path: 'spec.yaml', headers: { a: 'b' } }, output: 'gen' }, { cwd: root }).input).toEqual({
      path: resolve(root, 'spec.yaml'),
      headers: { a: 'b' },
    });
    const abs = resolve('/elsewhere/spec.yaml');
    expect(resolveConfig({ input: abs, output: '/out' }, { cwd: root })).toMatchObject({
      input: abs,
      output: { path: resolve('/out') },
    });
    expect(isAbsolute(resolveConfig({ input: 'a', output: 'b' }, { cwd: root }).output.path)).toBe(true);
  });

  it('leaves URL and object inputs untouched', () => {
    const url = 'https://example.com/openapi.json';
    expect(resolveConfig({ input: url, output: 'gen' }, { cwd: root }).input).toBe(url);
    const doc = { openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: {} };
    expect(resolveConfig({ input: doc, output: 'gen' }, { cwd: root }).input).toBe(doc);
  });

  it('warns no-plugins when diagnostics given and plugins empty', () => {
    const diagnostics = new Diagnostics();
    resolveConfig({ input: 'a', output: 'b' }, { cwd: root }, diagnostics);
    expect(diagnostics.entries.map((e) => e.code)).toEqual(['no-plugins']);
  });
});
