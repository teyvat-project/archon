import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { RustPluginOptions } from './index.js';
import { NON_RAW, PRELUDE_NAMES, RESERVED_MODULES, RS_KEYWORDS } from './reserved.js';

/** Replaces non-identifier characters with `_`; empty becomes `_`, a leading digit gets `_` prepended. */
export function sanitize(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '') id = '_';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** Converts to `c` and keeps only identifier characters. */
export function rsIdentifier(raw: string, c: NameCase): string {
  return sanitize(toCase(raw, c));
}

/** Keywords become raw identifiers (`r#type`); `self` / `Self` / `super` / `crate` / `_` get a trailing `_`. */
export function escapeKeyword(id: string): string {
  if (NON_RAW.has(id)) return `${id}_`;
  return RS_KEYWORDS.has(id) ? `r#${id}` : id;
}

/** A module or file name: keywords get a trailing `_` (a file named `r#type.rs` would be odd). */
export function moduleIdentifier(id: string): string {
  return RS_KEYWORDS.has(id) || NON_RAW.has(id) ? `${id}_` : id;
}

/** An identifier without its `r#`. */
export function bare(id: string): string {
  return id.replace(/^r#/, '');
}

/** The Cargo package name: `package.name`, or the title in kebab-case (`api` when nothing is left). */
export function packageName(ir: IRDocument, opts: RustPluginOptions): string {
  const configured = opts.package === false ? undefined : opts.package?.name;
  if (configured !== undefined && configured !== '') return configured;
  const name = toCase(ir.info.title, 'kebab-case') || 'api';
  return /^[0-9]/.test(name) ? `api-${name}` : name;
}

export type RsNames = {
  /** IR schema name → Rust type name. */
  types: Map<string, string>;
  /** IR schema name → module (and file) name under `src/models/`. */
  modules: Map<string, string>;
  /** Property wire name → Rust field name (a raw identifier when it is a keyword), for an object schema. */
  members(schemaName: string): Map<string, string>;
};

/**
 * Decides Rust type names (in `ir.schemas` order), their module names and, lazily, field names per struct. Type
 * names avoid `reserved` and the prelude names the generated code uses; module names are unique ignoring case (one
 * file per model on any file system) and differ from every type name.
 */
export function buildNames(ir: IRDocument, opts: RustPluginOptions, reserved: Iterable<string>): RsNames {
  const namer = new UniqueNamer([...reserved, ...PRELUDE_NAMES]);
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, rsIdentifier(name, typeRule.case ?? 'PascalCase'));
    types.set(name, escapeKeyword(namer.claim(sanitize(base))));
  }

  // Modules share the type namespace of `models`: only an all-lower-case type name can equal a module name.
  const lowerCaseTypes = [...types.values()].map(bare).filter((t) => t === t.toLowerCase());
  const moduleNamer = new UniqueNamer([...RESERVED_MODULES, ...lowerCaseTypes], { caseInsensitive: true });
  const modules = new Map<string, string>();
  for (const [name, typeName] of types) modules.set(name, moduleNamer.claim(moduleIdentifier(sanitize(fileBaseName(bare(typeName), opts)))));

  const memberCache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const members = (schemaName: string): Map<string, string> => {
    const cached = memberCache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    const taken = new UniqueNamer();
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      const base = sanitize(hooked ?? applyTemplate(propertyRule.name, rsIdentifier(p.name, propertyRule.case ?? 'snake_case')));
      out.set(p.name, escapeKeyword(taken.claim(base)));
    }
    memberCache.set(schemaName, out);
    return out;
  };

  return { types, modules, members };
}

/** The file (module) name for a type (`naming.file` / `hooks.fileName`; default: the type name in snake_case). */
export function fileBaseName(typeName: string, opts: RustPluginOptions): string {
  const rule = opts.naming.file ?? {};
  const hooked = opts.hooks.fileName?.(typeName);
  return hooked ?? applyTemplate(rule.name, toCase(typeName, rule.case ?? 'snake_case') || '_');
}
