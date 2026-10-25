export type NameCase = 'camelCase' | 'PascalCase' | 'snake_case' | 'SCREAMING_SNAKE_CASE' | 'kebab-case' | 'preserve';

/**
 * 識別子を単語に分割する。
 * 英数字以外・小文字(数字)→大文字・頭字語→単語（HTTPServer → HTTP|Server）で分割する。
 * 文字↔数字の境界では分割しない（V1 は 1 語、"v1.1" は v1|1）。
 */
export function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

export function toCase(input: string, c: NameCase): string {
  if (c === 'preserve') return input;
  const words = splitWords(input);
  switch (c) {
    case 'camelCase':
      return words.map((w, i) => (i === 0 ? w.toLowerCase() : capitalize(w))).join('');
    case 'PascalCase':
      return words.map(capitalize).join('');
    case 'snake_case':
      return words.map((w) => w.toLowerCase()).join('_');
    case 'SCREAMING_SNAKE_CASE':
      return words.map((w) => w.toUpperCase()).join('_');
    case 'kebab-case':
      return words.map((w) => w.toLowerCase()).join('-');
  }
}

/** `{{name}}` を `name` に置換する。関数ならそのまま適用し、`undefined` なら `name` を返す。 */
export function applyTemplate(template: string | ((name: string) => string) | undefined, name: string): string {
  if (template === undefined) return name;
  if (typeof template === 'function') return template(name);
  return template.replaceAll('{{name}}', name);
}

/** 衝突した名前に数値接尾辞（base2, base3…）を付けて一意にする。 */
export class UniqueNamer {
  private readonly taken = new Set<string>();
  private readonly caseInsensitive: boolean;

  constructor(reserved: Iterable<string> = [], opts: { caseInsensitive?: boolean } = {}) {
    this.caseInsensitive = opts.caseInsensitive ?? false;
    for (const name of reserved) this.taken.add(this.key(name));
  }

  claim(base: string): string {
    let name = base;
    for (let n = 2; this.taken.has(this.key(name)); n++) name = `${base}${n}`;
    this.taken.add(this.key(name));
    return name;
  }

  private key(name: string): string {
    return this.caseInsensitive ? name.toLowerCase() : name;
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
