import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { GoPluginOptions } from './index.js';
import { FILE_SUFFIXES, GO_KEYWORDS, MODEL_METHODS, PACKAGE_NAMES } from './reserved.js';

/** Converts to `c` and keeps only identifier characters (see `sanitize`). */
export function goIdentifier(raw: string, c: NameCase): string {
  return sanitize(toCase(raw, c));
}

/** Replaces non-identifier characters with `_`; empty becomes `_`. */
export function sanitize(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_');
  return id === '' ? '_' : id;
}

/** An exported identifier: a lower-case first letter is capitalized, anything but a letter gets `X` prepended. */
export function exported(name: string): string {
  const id = sanitize(name);
  if (/^[a-z]/.test(id)) return id.charAt(0).toUpperCase() + id.slice(1);
  return /^[A-Z]/.test(id) ? id : `X${id}`;
}

/** An unexported identifier (`fooBar`); keywords get a trailing `_`. */
export function unexported(raw: string): string {
  let id = goIdentifier(raw, 'camelCase');
  if (/^[0-9_]/.test(id)) id = `x${id}`;
  return GO_KEYWORDS.has(id) ? `${id}_` : id;
}

/**
 * `opts.packageName`, or the title reduced to lower-case letters and digits (`'Archon Edge Cases'` →
 * `archonedgecases`; `api` when nothing is left). Keywords get a trailing `_`, a leading digit gets `api` prepended.
 */
export function resolvePackageName(ir: IRDocument, opts: GoPluginOptions): string {
  const raw = opts.packageName !== undefined && opts.packageName !== '' ? opts.packageName : ir.info.title.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let name = sanitize(raw);
  if (name === '_' || raw === '') name = 'api';
  if (/^[0-9]/.test(name)) name = `api${name}`;
  return GO_KEYWORDS.has(name) ? `${name}_` : name;
}

/** The module path: `opts.module`, or the package name. */
export function resolveModule(packageName: string, opts: GoPluginOptions): string {
  return opts.module !== undefined && opts.module !== '' ? opts.module : packageName;
}

export type GoNames = {
  /** IR schema name → Go type name. */
  types: Map<string, string>;
  /** IR schema name → file name (`<snake>_model.go`, unique ignoring case). */
  files: Map<string, string>;
  /** Property wire name → Go field name, for an object schema. */
  fields(schemaName: string): Map<string, string>;
  /** Claims another exported package-level name (enum constants, Params types, ...). */
  claim(base: string): string;
  /** Claims an unexported package-level name (operation specs, error tables). */
  claimLocal(base: string): string;
  /** Claims a file name (`<base>.go`, unique ignoring case). */
  claimFile(base: string): string;
};

/**
 * Decides Go type names (in `ir.schemas` order) and, lazily, field names per struct. Every exported package-level
 * name shares one namespace: `reserved` (services) and the client's own names are claimed first.
 */
export function buildNames(ir: IRDocument, opts: GoPluginOptions, reserved: Iterable<string>): GoNames {
  const namer = new UniqueNamer([...PACKAGE_NAMES, ...reserved]);
  const locals = new UniqueNamer(['securitySchemes']);
  const fileNamer = new UniqueNamer(['client', 'auth', 'go'], { caseInsensitive: true });
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  const files = new Map<string, string>();
  const claimFile = (base: string) => {
    let name = sanitizeFile(base);
    // `_test.go` files are tests and `_linux.go` / `_arm64.go` files are platform-specific.
    if (FILE_SUFFIXES.has(name.split('_').pop() ?? '')) name = `${name}_`;
    return `${fileNamer.claim(name)}.go`;
  };
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, goIdentifier(name, typeRule.case ?? 'PascalCase'));
    const typeName = namer.claim(exported(base));
    types.set(name, typeName);
    files.set(name, claimFile(fileBaseName(typeName, opts)));
  }

  const fieldCache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const fields = (schemaName: string): Map<string, string> => {
    const cached = fieldCache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    // encoding/json matches keys ignoring case when no field matches exactly, so names stay unique ignoring case.
    const taken = new UniqueNamer(MODEL_METHODS, { caseInsensitive: true });
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      out.set(p.name, taken.claim(exported(hooked ?? applyTemplate(propertyRule.name, goIdentifier(p.name, propertyRule.case ?? 'PascalCase')))));
    }
    fieldCache.set(schemaName, out);
    return out;
  };

  return {
    types,
    files,
    fields,
    claim: (base) => namer.claim(exported(base)),
    claimLocal: (base) => locals.claim(base),
    claimFile,
  };
}

/** The file base name for a type (`naming.file` / `hooks.fileName`; default `<snake_case>_model`). */
export function fileBaseName(typeName: string, opts: GoPluginOptions): string {
  const rule = opts.naming.file ?? {};
  const hooked = opts.hooks.fileName?.(typeName);
  return hooked ?? applyTemplate(rule.name, `${toCase(typeName, rule.case ?? 'snake_case')}_model`);
}

/** File names may not start with `_` or `.` (the go tool ignores those). */
function sanitizeFile(base: string): string {
  const name = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[_.]+/, '');
  return name === '' ? 'model' : name;
}
