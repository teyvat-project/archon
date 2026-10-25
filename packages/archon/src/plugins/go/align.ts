/**
 * A row of cells as gofmt sees it: every cell but the last is aligned in its column; a string is a line without
 * cells (a comment or a blank line), which ends the alignment blocks it interrupts.
 */
export type Row = string | string[];

/**
 * Lays rows out the way gofmt does for struct fields, `const` groups and multi-line keyed literals: gofmt writes
 * them through text/tabwriter (padding 1, spaces, DiscardEmptyColumns), whose column blocks are runs of consecutive
 * lines that all have a cell in that column.
 */
export function align(rows: Row[]): string[] {
  const lines = rows.map((row) => (typeof row === 'string' ? [row] : row));
  const out: string[] = new Array<string>(lines.length);
  const width = (cell: string) => [...cell].length;

  const write = (from: number, to: number, widths: number[]) => {
    for (let i = from; i < to; i++) {
      const line = lines[i] as string[];
      out[i] = line
        .map((cell, j) => (j < line.length - 1 && j < widths.length ? cell + ' '.repeat(Math.max((widths[j] as number) - width(cell), 0)) : cell))
        .join('');
    }
  };

  // text/tabwriter's Writer.format.
  const format = (line0: number, line1: number, widths: number[]) => {
    const column = widths.length;
    let start = line0;
    for (let i = line0; i < line1; i++) {
      if (column >= (lines[i] as string[]).length - 1) continue;
      write(start, i, widths);
      start = i;
      let w = 0;
      let discardable = true;
      for (; i < line1; i++) {
        const line = lines[i] as string[];
        if (column >= line.length - 1) break;
        const cell = line[column] as string;
        w = Math.max(w, width(cell) + 1);
        if (cell !== '') discardable = false;
      }
      format(start, i, [...widths, discardable ? 0 : w]);
      start = i;
    }
    write(start, line1, widths);
  };

  format(0, lines.length, []);
  return out;
}

/**
 * The lines of a doc comment in the form gofmt keeps: lines trimmed (an indented line would be a code block or a
 * list item, which gofmt re-indents), runs of blank lines collapsed, no leading or trailing blank line.
 */
export function docLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
