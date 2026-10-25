/**
 * 生成する型名・値名として使えない（または使うと生成コードが壊れる）識別子。
 * 一致した名前には `_` を後置する。比較は大文字小文字を区別する。
 */
export const TS_RESERVED: ReadonlySet<string> = new Set([
  // ECMAScript reserved words
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  // strict mode / module code
  'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield', 'await',
  'arguments', 'eval',
  // TS: `export type as = …` が構文エラーになる
  'as',
  // TS: 型エイリアス名にできない組み込み型名
  'any', 'unknown', 'never', 'string', 'number', 'boolean', 'symbol', 'object', 'bigint', 'undefined',
  // 生成コード（types.gen.ts）が参照するグローバル型。同名の宣言で隠すと参照先が変わる
  'Blob', 'Date',
]);
