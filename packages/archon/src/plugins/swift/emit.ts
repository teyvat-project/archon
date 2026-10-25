import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import type { SwiftPluginOptions } from './index.js';

/** A writer with 4-space indentation, the generated header and the imports. */
export function swiftFile(ctx: PluginContext<SwiftPluginOptions>, imports: string[]): CodeWriter {
  const w = ctx.writer({ indent: '    ' });
  w.comment(ctx.headerLines('swift'), 'line');
  w.blank();
  for (const i of imports) w.line(`import ${i}`);
  w.blank();
  return w;
}

/** `///` lines; nothing for an empty text. */
export function doc(w: CodeWriter, text: string | undefined): void {
  if (text === undefined || text.trim() === '') return;
  for (const line of text.trim().split('\n')) w.line(line.trim() === '' ? '///' : `/// ${line.trimEnd()}`);
}

/** A Swift string literal. */
export function literal(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A block: `header {`, the indented body, `}`. */
export function block(w: CodeWriter, header: string, fn: () => void): void {
  w.block(`${header} {`, fn);
}

/** A `switch`: `header {`, the cases at the same indentation (Swift style), `}`. */
export function switchBlock(w: CodeWriter, header: string, fn: () => void): void {
  w.line(`${header} {`);
  fn();
  w.line('}');
}
