import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { CSharpPluginOptions } from './index.js';
import { CS_KEYWORDS, RESERVED_MEMBERS } from './reserved.js';

/** Converts to `c` and keeps only identifier characters; empty becomes `_`, a leading digit gets `_` prepended. */
export function csIdentifier(raw: string, c: NameCase): string {
  return sanitize(toCase(raw, c));
}

/** Replaces non-identifier characters with `_`; empty becomes `_`, a leading digit gets `_` prepended. */
export function sanitize(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '') id = '_';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** Prefixes C# keywords with `@`. */
export function escapeKeyword(id: string): string {
  return CS_KEYWORDS.has(id) ? `@${id}` : id;
}

/** `opts.namespace`, or the title with each `.`-separated part in PascalCase (`'Archon Edge Cases'` → `ArchonEdgeCases`). */
export function resolveNamespace(ir: IRDocument, opts: CSharpPluginOptions): string {
  if (opts.namespace !== undefined && opts.namespace !== '') return opts.namespace;
  return ir.info.title
    .split('.')
    .map((part) => csIdentifier(part, 'PascalCase'))
    .filter((part) => part !== '_')
    .join('.') || 'Api';
}

export type CsNames = {
  /** IR schema name → C# type name. */
  types: Map<string, string>;
  /** Property wire name → C# property name, for an object schema. */
  members(schemaName: string): Map<string, string>;
};

/**
 * Decides C# type names (in `ir.schemas` order; case-insensitive because each type gets its own file) and,
 * lazily, property names per class. Property names avoid the enclosing type name and the members every class
 * inherits (`Echo.echo` → `EchoValue`, `equals` → `EqualsValue`); remaining clashes get numeric suffixes.
 */
export function buildNames(ir: IRDocument, opts: CSharpPluginOptions, reserved: Iterable<string>): CsNames {
  const namer = new UniqueNamer(reserved, { caseInsensitive: true });
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, csIdentifier(name, typeRule.case ?? 'PascalCase'));
    types.set(name, namer.claim(escapeKeyword(sanitize(base))));
  }

  const memberCache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const members = (schemaName: string): Map<string, string> => {
    const cached = memberCache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    const className = types.get(schemaName) ?? schemaName;
    const taken = new UniqueNamer([...RESERVED_MEMBERS, className]);
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      let base = sanitize(hooked ?? applyTemplate(propertyRule.name, csIdentifier(p.name, propertyRule.case ?? 'PascalCase')));
      if (base === className || RESERVED_MEMBERS.includes(base)) base = `${base}Value`;
      out.set(p.name, escapeKeyword(taken.claim(base)));
    }
    memberCache.set(schemaName, out);
    return out;
  };

  return { types, members };
}

/** The file base name for a type (`naming.file` / `hooks.fileName`; default: the type name). */
export function fileBaseName(typeName: string, opts: CSharpPluginOptions): string {
  const rule = opts.naming.file ?? {};
  const hooked = opts.hooks.fileName?.(typeName);
  return hooked ?? applyTemplate(rule.name, rule.case === undefined ? typeName.replace(/^@/, '') : toCase(typeName, rule.case));
}
