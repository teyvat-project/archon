import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import type { RustPluginOptions } from './index.js';

/** A writer with 4-space indentation and the generated header. */
export function rsWriter(ctx: PluginContext<RustPluginOptions>): CodeWriter {
  const w = ctx.writer({ indent: '    ' });
  w.comment(ctx.headerLines('rust'), 'line');
  w.blank();
  return w;
}

/**
 * Doc comment lines for `text` (`///`, or `//!` for inner docs); nothing for an empty description. Descriptions are
 * Markdown, and rustdoc compiles Rust code blocks as doctests, so fenced blocks without a language (or marked Rust)
 * become `text` blocks and lines outside fences lose their indentation (an indented block is a code block too).
 */
export function docLines(text: string | undefined, inner = false): string[] {
  if (text === undefined || text.trim() === '') return [];
  const prefix = inner ? '//!' : '///';
  const out: string[] = [];
  let fence: string | undefined;
  for (const raw of text.trim().replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw;
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence === undefined && marker) {
      fence = marker[1] as string;
      const info = (marker[2] as string).trim();
      const rust = info === '' || /^(rust|rs)\b/i.test(info) || /^(ignore|no_run|should_panic|compile_fail)\b/.test(info);
      line = `${fence}${rust ? 'text' : info}`;
    } else if (fence !== undefined && marker && (marker[1] as string).startsWith(fence) && (marker[2] as string).trim() === '') {
      fence = undefined;
      line = raw.trim();
    } else if (fence === undefined) {
      line = raw.trim();
    }
    out.push(line === '' ? prefix : `${prefix} ${line}`);
  }
  if (fence !== undefined) out.push(`${prefix} ${fence}`);
  return out;
}

export function doc(w: CodeWriter, text: string | undefined, inner = false): void {
  for (const line of docLines(text, inner)) w.line(line);
}

/** A Rust string literal (lone surrogates, which Rust strings cannot hold, become U+FFFD). */
export function literal(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (code >= 0xd800 && code <= 0xdfff) out += '\\u{fffd}';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A TOML basic string (JSON escapes are valid TOML; DEL and the Unicode line separators are escaped as well). */
export function tomlString(value: string): string {
  let out = '';
  for (const ch of JSON.stringify(value)) {
    const code = ch.codePointAt(0) as number;
    out += code === 0x7f || code === 0x2028 || code === 0x2029 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}
