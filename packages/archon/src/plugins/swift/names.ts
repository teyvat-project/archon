import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { SwiftPluginOptions } from './index.js';
import { RESERVED_PROPERTIES, STANDARD_TYPES, SWIFT_KEYWORDS } from './reserved.js';

/** Converts to `c` and keeps only identifier characters; empty becomes `_`, a leading digit gets `_` prepended. */
export function swIdentifier(raw: string, c: NameCase): string {
  return sanitize(toCase(raw, c));
}

/** Replaces non-identifier characters with `_`; empty becomes `_`, a leading digit gets `_` prepended. */
export function sanitize(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '') id = '_';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** Wraps Swift keywords in backticks. */
export function escape(id: string): string {
  return SWIFT_KEYWORDS.has(id) ? `\`${id}\`` : id;
}

/** `opts.moduleName`, or the title in PascalCase (`'Archon Edge Cases'` → `ArchonEdgeCases`). */
export function resolveModuleName(ir: IRDocument, opts: SwiftPluginOptions): string {
  if (opts.moduleName !== undefined && opts.moduleName !== '') return sanitize(opts.moduleName);
  const name = swIdentifier(ir.info.title, 'PascalCase');
  return name === '_' ? 'Api' : name;
}

export type SwNames = {
  /** IR schema name → Swift type name. */
  types: Map<string, string>;
  /** Property wire name → Swift property name (unescaped), for an object schema. */
  members(schemaName: string): Map<string, string>;
  /** A standard library / Foundation type, module-qualified when the SDK declares a type of the same name. */
  std(name: keyof typeof STANDARD_TYPES): string;
};

/**
 * Decides Swift type names (in `ir.schemas` order; case-insensitive because each type gets its own file) and, lazily,
 * property names per struct. `declared` lists the other names the SDK module declares (client, services, ...).
 */
export function buildNames(ir: IRDocument, opts: SwiftPluginOptions, reserved: Iterable<string>, declared: Iterable<string>): SwNames {
  const namer = new UniqueNamer(reserved, { caseInsensitive: true });
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, swIdentifier(name, typeRule.case ?? 'PascalCase'));
    let id = sanitize(base);
    if (SWIFT_KEYWORDS.has(id)) id = `${id}Model`;
    types.set(name, namer.claim(id));
  }

  const memberCache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const members = (schemaName: string): Map<string, string> => {
    const cached = memberCache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    const taken = new UniqueNamer(RESERVED_PROPERTIES);
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      let base = sanitize(hooked ?? applyTemplate(propertyRule.name, swIdentifier(p.name, propertyRule.case ?? 'camelCase')));
      if (RESERVED_PROPERTIES.includes(base)) base = `${base}Value`;
      out.set(p.name, taken.claim(base));
    }
    memberCache.set(schemaName, out);
    return out;
  };

  // Swift names are case-sensitive: only an exact match shadows the standard type.
  const taken = new Set([...types.values(), ...declared]);
  const std = (name: keyof typeof STANDARD_TYPES): string => (taken.has(name) ? `${STANDARD_TYPES[name]}.${name}` : name);

  return { types, members, std };
}

/** The file base name for a type (`naming.file` / `hooks.fileName`; default: the type name). */
export function fileBaseName(typeName: string, opts: SwiftPluginOptions): string {
  const rule = opts.naming.file ?? {};
  const hooked = opts.hooks.fileName?.(typeName);
  return hooked ?? applyTemplate(rule.name, rule.case === undefined ? typeName : toCase(typeName, rule.case));
}
