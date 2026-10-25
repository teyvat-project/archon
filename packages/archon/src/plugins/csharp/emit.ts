import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import type { CSharpPluginOptions } from './index.js';

export const G = 'global::System';
export const GEN = `${G}.Collections.Generic`;
export const STJ = `${G}.Text.Json`;
export const SER = `${STJ}.Serialization`;

/** A writer with 4-space indentation, the generated header, nullable context and the namespace. */
export function csFile(ctx: PluginContext<CSharpPluginOptions>, namespace: string, usings: string[] = []): CodeWriter {
  const w = ctx.writer({ indent: '    ' });
  w.comment(ctx.headerLines('csharp'), 'line');
  w.blank();
  w.line('#nullable enable');
  // Generated code refers to deprecated members itself; CS1573 / CS1591 matter only to projects that build XML docs.
  w.line('#pragma warning disable CS0612, CS0618, CS1573, CS1591');
  w.blank();
  for (const u of usings) w.line(`using ${u};`);
  w.blank();
  w.line(`namespace ${namespace};`);
  w.blank();
  return w;
}

/** `/// <summary>` lines (XML-escaped); nothing for an empty description. */
export function summary(w: CodeWriter, text: string | undefined): void {
  if (text === undefined || text.trim() === '') return;
  w.line('/// <summary>');
  for (const line of escapeXml(text.trim()).split('\n')) w.line(line === '' ? '///' : `/// ${line}`);
  w.line('/// </summary>');
}

export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A C# regular string literal. */
export function literal(value: string): string {
  // U+2028 / U+2029 end a line in C#, so they are escaped too.
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
