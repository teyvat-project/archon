import { describe, expect, it } from 'vitest';
import { align, docLines } from '../../../src/plugins/go/align.js';

describe('go plugin: gofmt alignment', () => {
  it('aligns every cell but the last one', () => {
    expect(align([['A', 'int', '`json:"a"`'], ['LongName', 'string', '`json:"long"`']])).toEqual([
      'A        int    `json:"a"`',
      'LongName string `json:"long"`',
    ]);
  });

  it('starts a new block after a comment line, as gofmt does', () => {
    expect(align([['A', 'int', '`json:"a"`'], '// doc', ['LongName', 'string', '`json:"long"`'], ['C', 'bool']])).toEqual([
      'A int `json:"a"`',
      '// doc',
      'LongName string `json:"long"`',
      'C        bool',
    ]);
  });

  it('ends a column at a line without a cell in it (a field without a tag)', () => {
    // gofmt: the type column of DD starts a new block after C, which has no tag.
    expect(align([['LongName', 'string', '`a`'], ['C', 'bool'], ['DD', 'string', '`b`']])).toEqual([
      'LongName string `a`',
      'C        bool',
      'DD       string `b`',
    ]);
  });

  it('counts runes, not UTF-16 units', () => {
    expect(align([['日本', 'x'], ['ab', 'y']])).toEqual(['日本 x', 'ab y']);
  });

  it('normalizes doc comments to what gofmt keeps', () => {
    expect(docLines('  First line  \r\n\n\n  - indented item\n\tcode\n\n')).toEqual(['First line', '', '- indented item', 'code']);
    expect(docLines(undefined)).toEqual([]);
    expect(docLines('\n\n')).toEqual([]);
  });
});
