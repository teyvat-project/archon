import { describe, expect, it } from 'vitest';
import { CodeWriter } from '../../src/writer/code-writer.js';

describe('CodeWriter', () => {
  it('indents nested blocks with 2 spaces by default', () => {
    const w = new CodeWriter();
    w.block('export interface A {', () => {
      w.line('a: string;');
      w.block('b: {', () => w.line('c: number;'), '};');
    });
    expect(w.toString()).toBe(['export interface A {', '  a: string;', '  b: {', '    c: number;', '  };', '}', ''].join('\n'));
  });

  it('supports a custom indent unit', () => {
    const w = new CodeWriter({ indent: '\t' });
    w.indent(() => w.line('x'));
    expect(w.toString()).toBe('\tx\n');
  });

  it('collapses consecutive blank lines and drops leading ones', () => {
    const w = new CodeWriter();
    w.blank().line('a').blank().blank().blank().line('b');
    expect(w.toString()).toBe('a\n\nb\n');
  });

  it('does not indent blank lines or leave trailing blank lines', () => {
    const w = new CodeWriter();
    w.indent(() => w.line('a').blank().line('b').blank());
    expect(w.toString()).toBe('  a\n\n  b\n');
  });

  it('lines() writes each text and multi-line text is indented per line', () => {
    const w = new CodeWriter();
    w.indent(() => w.lines(['a', 'b\nc']));
    expect(w.toString()).toBe('  a\n  b\n  c\n');
  });

  it('line() with no text writes an empty line', () => {
    const w = new CodeWriter();
    w.line('a').line().line().line('b');
    expect(w.toString()).toBe('a\n\n\nb\n');
  });

  it('restores indentation when the callback throws', () => {
    const w = new CodeWriter();
    expect(() =>
      w.indent(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    w.line('a');
    expect(w.toString()).toBe('a\n');
  });

  it('block() accepts a custom close', () => {
    const w = new CodeWriter();
    w.block('foo(', () => w.line('x,'), ');');
    expect(w.toString()).toBe('foo(\n  x,\n);\n');
  });

  it('writes jsdoc comments and escapes */', () => {
    const w = new CodeWriter();
    w.comment(['a */ b', '', 'second'], 'jsdoc');
    expect(w.toString()).toBe('/**\n * a *\\/ b\n *\n * second\n */\n');
  });

  it('writes line comments and indents them', () => {
    const w = new CodeWriter();
    w.indent(() => w.comment(['a', '', 'b'], 'line'));
    expect(w.toString()).toBe('  // a\n  //\n  // b\n');
  });

  it('emits nothing for empty comments', () => {
    const w = new CodeWriter();
    w.comment([], 'jsdoc').comment([], 'line');
    expect(w.toString()).toBe('');
  });

  it('splits embedded newlines in comment lines', () => {
    const w = new CodeWriter();
    w.comment(['a\nb'], 'jsdoc');
    expect(w.toString()).toBe('/**\n * a\n * b\n */\n');
  });
});
