import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { KotlinPluginOptions } from './index.js';
import { BUILTIN_TYPES, IMPORTED_NAMES, KT_KEYWORDS } from './reserved.js';

/** Converts to `c` and keeps only identifier characters; empty becomes `_`, a leading digit gets `_` prepended. */
export function ktIdentifier(raw: string, c: NameCase): string {
  return sanitize(toCase(raw, c));
}

/** Replaces non-identifier characters with `_`; empty becomes `_`, a leading digit gets `_` prepended. */
export function sanitize(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '') id = '_';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** Wraps hard keywords in backticks. */
export function escapeKeyword(id: string): string {
  return KT_KEYWORDS.has(id) ? `\`${id}\`` : id;
}

/** An identifier without its backticks. */
export function bare(id: string): string {
  return id.replace(/^`|`$/g, '');
}

/**
 * `opts.packageName`, or the title with each `.`-separated part reduced to lower-case letters and digits
 * (`'Archon Edge Cases'` → `archonedgecases`; `api` when nothing is left).
 */
export function resolvePackageName(ir: IRDocument, opts: KotlinPluginOptions): string {
  if (opts.packageName !== undefined && opts.packageName !== '') return opts.packageName;
  return (
    ir.info.title
      .split('.')
      .map((part) => part.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
      .filter((part) => part !== '')
      .map((part) => (/^[0-9]/.test(part) ? `_${part}` : part))
      .join('.') || 'api'
  );
}

/** The package as written in code (keyword segments in backticks). */
export function packageCode(packageName: string): string {
  return packageName.split('.').map(escapeKeyword).join('.');
}

/** The source directory of a package (`com.example` → `src/main/kotlin/com/example`). */
export function packageDir(packageName: string): string {
  return `src/main/kotlin/${packageName.split('.').join('/')}`;
}

export type KtNames = {
  /** IR schema name → Kotlin type name. */
  types: Map<string, string>;
  /** IR schema name → file base name (unique ignoring case: one file per type on any file system). */
  files: Map<string, string>;
  /** Property wire name → Kotlin property name (in backticks when it is a keyword), for an object schema. */
  members(schemaName: string): Map<string, string>;
};

/**
 * Decides Kotlin type names (in `ir.schemas` order) and, lazily, property names per class. Type names avoid
 * `reserved`, the default-imported types the generated code uses and the names it imports. Property names are
 * unique ignoring case (`fooBar` and `FooBar` would both get the JVM getter `getFooBar`); `class` becomes
 * `classValue` (its getter would be `getClass`).
 */
export function buildNames(ir: IRDocument, opts: KotlinPluginOptions, reserved: Iterable<string>): KtNames {
  const namer = new UniqueNamer([...reserved, ...BUILTIN_TYPES, ...IMPORTED_NAMES]);
  const fileNamer = new UniqueNamer([], { caseInsensitive: true });
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  const files = new Map<string, string>();
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, ktIdentifier(name, typeRule.case ?? 'PascalCase'));
    const typeName = escapeKeyword(namer.claim(sanitize(base)));
    types.set(name, typeName);
    files.set(name, fileNamer.claim(fileBaseName(typeName, opts)));
  }

  const memberCache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const members = (schemaName: string): Map<string, string> => {
    const cached = memberCache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    const taken = new UniqueNamer([], { caseInsensitive: true });
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      let base = sanitize(hooked ?? applyTemplate(propertyRule.name, ktIdentifier(p.name, propertyRule.case ?? 'camelCase')));
      if (base === 'class') base = 'classValue';
      out.set(p.name, escapeKeyword(taken.claim(base)));
    }
    memberCache.set(schemaName, out);
    return out;
  };

  return { types, files, members };
}

/** The file base name for a type (`naming.file` / `hooks.fileName`; default: the type name). */
export function fileBaseName(typeName: string, opts: KotlinPluginOptions): string {
  const rule = opts.naming.file ?? {};
  const hooked = opts.hooks.fileName?.(bare(typeName));
  return hooked ?? applyTemplate(rule.name, rule.case === undefined ? bare(typeName) : toCase(bare(typeName), rule.case));
}
