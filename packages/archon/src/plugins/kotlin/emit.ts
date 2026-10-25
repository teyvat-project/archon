import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import type { KotlinPluginOptions } from './index.js';
import { packageCode } from './names.js';

/** Names the generated code may use, by the import that provides them. */
const IMPORTS: Record<string, string> = {
  Serializable: 'kotlinx.serialization.Serializable',
  SerialName: 'kotlinx.serialization.SerialName',
  EncodeDefault: 'kotlinx.serialization.EncodeDefault',
  KSerializer: 'kotlinx.serialization.KSerializer',
  SerializationException: 'kotlinx.serialization.SerializationException',
  ExperimentalSerializationApi: 'kotlinx.serialization.ExperimentalSerializationApi',
  ListSerializer: 'kotlinx.serialization.builtins.ListSerializer',
  MapSerializer: 'kotlinx.serialization.builtins.MapSerializer',
  SerialDescriptor: 'kotlinx.serialization.descriptors.SerialDescriptor',
  PrimitiveSerialDescriptor: 'kotlinx.serialization.descriptors.PrimitiveSerialDescriptor',
  PrimitiveKind: 'kotlinx.serialization.descriptors.PrimitiveKind',
  Encoder: 'kotlinx.serialization.encoding.Encoder',
  Decoder: 'kotlinx.serialization.encoding.Decoder',
  JsonElement: 'kotlinx.serialization.json.JsonElement',
  JsonObject: 'kotlinx.serialization.json.JsonObject',
  JsonPrimitive: 'kotlinx.serialization.json.JsonPrimitive',
  JsonArray: 'kotlinx.serialization.json.JsonArray',
  JsonDecoder: 'kotlinx.serialization.json.JsonDecoder',
  JsonEncoder: 'kotlinx.serialization.json.JsonEncoder',
  HttpMethod: 'io.ktor.http.HttpMethod',
  HttpClient: 'io.ktor.client.HttpClient',
};

/**
 * The imports `code` needs: kotlinx / Ktor names from the table, runtime types (from `<package>.core`) and the
 * builtin `serializer()` / `nullable` extensions. Comments and string literals are ignored.
 */
export function importsFor(code: string, packageName: string, runtimeNames: Iterable<string>): string[] {
  const text = code
    .split('\n')
    .filter((line) => !/^\s*(\/\*\*|\*|\/\/)/.test(line))
    .join('\n')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const used = (name: string) => new RegExp(`(?<![.\\w])${name}\\b`).test(text);
  const out = new Set<string>();
  for (const [name, fqn] of Object.entries(IMPORTS)) if (used(name)) out.add(fqn);
  for (const name of runtimeNames) if (used(name)) out.add(`${packageCode(packageName)}.core.${name}`);
  if (/\b(?:String|Int|Long|Double|Float|Boolean|Short|Byte|Char)\.serializer\(\)/.test(text)) out.add('kotlinx.serialization.builtins.serializer');
  if (/\.nullable\b/.test(text)) out.add('kotlinx.serialization.builtins.nullable');
  return [...out];
}

/**
 * A writer with 4-space indentation, the generated header, `@file:Suppress` (generated code refers to deprecated
 * declarations itself), `@file:OptIn` when asked, the package and the imports (sorted).
 */
export function ktFile(ctx: PluginContext<KotlinPluginOptions>, packageName: string, imports: string[], opts: { optIn?: boolean } = {}): CodeWriter {
  const w = ctx.writer({ indent: '    ' });
  w.comment(ctx.headerLines('kotlin'), 'line');
  w.blank();
  w.line('@file:Suppress("DEPRECATION", "RedundantVisibilityModifier")');
  if (opts.optIn) w.line('@file:OptIn(ExperimentalSerializationApi::class)');
  w.blank();
  w.line(`package ${packageCode(packageName)}`);
  w.blank();
  for (const i of [...new Set(imports)].sort()) w.line(`import ${i}`);
  w.blank();
  return w;
}

/** A Kotlin file of `body`, importing what the body uses. */
export function ktSource(
  ctx: PluginContext<KotlinPluginOptions>,
  filePackage: string,
  rootPackage: string,
  runtimeNames: Iterable<string>,
  body: string,
  extraImports: string[] = [],
): string {
  const imports = [...importsFor(body, rootPackage, runtimeNames), ...extraImports];
  const optIn = /@EncodeDefault\b|\bSerialDescriptor\(/.test(body);
  if (optIn) imports.push('kotlinx.serialization.ExperimentalSerializationApi');
  const w = ktFile(ctx, filePackage, imports, { optIn });
  w.line(body.replace(/\n$/, ''));
  return w.toString();
}

/**
 * A KDoc block; nothing for an empty description. Kotlin block comments nest, so both `*\/` and `/*` are broken
 * up (the slash becomes `&#47;`, which KDoc renders as a slash).
 */
export function kdoc(w: CodeWriter, text: string | undefined): void {
  if (text === undefined || text.trim() === '') return;
  const safe = text.trim().replaceAll('*/', '*&#47;').replaceAll('/*', '&#47;*');
  w.line('/**');
  for (const line of safe.split('\n')) w.line(line === '' ? ' *' : ` * ${line}`);
  w.line(' */');
}

/** A Kotlin string literal (`$` is escaped so it never starts a template). */
export function literal(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}
