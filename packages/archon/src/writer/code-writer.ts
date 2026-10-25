/** インデント付きでコードを組み立てる。`toString()` は末尾改行を 1 つ付けて返す。 */
export class CodeWriter {
  private readonly out: string[] = [];
  private readonly unit: string;
  private level = 0;

  constructor(opts: { indent?: string } = {}) {
    this.unit = opts.indent ?? '  ';
  }

  /** 1 行出力する。引数なし/空文字は空行（`blank()` と違い連続していても抑止しない）。改行を含む場合は行ごとにインデントする。 */
  line(text = ''): this {
    for (const part of text.split('\n')) {
      this.out.push(part === '' ? '' : this.unit.repeat(this.level) + part);
    }
    return this;
  }

  lines(texts: string[]): this {
    for (const text of texts) this.line(text);
    return this;
  }

  /** 空行を出す。直前が空行のとき、および先頭では何もしない。 */
  blank(): this {
    if (this.out.length > 0 && this.out[this.out.length - 1] !== '') this.out.push('');
    return this;
  }

  indent(fn: () => void): this {
    this.level++;
    try {
      fn();
    } finally {
      this.level--;
    }
    return this;
  }

  block(open: string, fn: () => void, close = '}'): this {
    this.line(open);
    this.indent(fn);
    return this.line(close);
  }

  // 空配列なら何も出さない。jsdoc ではコメント終端（アスタリスク + スラッシュ）をバックスラッシュでエスケープする。
  comment(lines: string[], style: 'jsdoc' | 'line'): this {
    if (lines.length === 0) return this;
    const rows = lines.flatMap((l) => l.split('\n'));
    if (style === 'line') {
      for (const row of rows) this.line(row === '' ? '//' : `// ${row}`);
      return this;
    }
    this.line('/**');
    for (const row of rows) {
      const escaped = row.replaceAll('*/', '*\\/');
      this.line(escaped === '' ? ' *' : ` * ${escaped}`);
    }
    return this.line(' */');
  }

  toString(): string {
    const lines = [...this.out];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
