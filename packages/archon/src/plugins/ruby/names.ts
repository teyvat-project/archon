import type { IRDocument } from '../../ir/types.js';
import { applyTemplate, toCase, UniqueNamer, type NameCase } from '../../writer/naming.js';
import type { RubyPluginOptions } from './index.js';
import { MODULE_CONSTANTS, OBJECT_METHODS, RUBY_KEYWORDS } from './reserved.js';

/** A constant name: non-identifier characters become `_`, and anything not starting with an upper-case letter gets `X`. */
export function constant(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[a-z]/.test(id)) return id.charAt(0).toUpperCase() + id.slice(1);
  return /^[A-Z]/.test(id) ? id : `X${id}`;
}

/**
 * A method, argument or member name in snake_case (or `c`): a leading digit gets `_`, keywords and Object methods a
 * trailing `_` (`class_`, `end_`); an empty name becomes `value`.
 */
export function rubyIdentifier(raw: string, c: NameCase = 'snake_case'): string {
  let id = toCase(raw, c).replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '' || /^_+$/.test(id)) id = 'value';
  if (/^[A-Z]/.test(id)) id = id.charAt(0).toLowerCase() + id.slice(1);
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return RUBY_KEYWORDS.has(id) || OBJECT_METHODS.has(id) ? `${id}_` : id;
}

/** A SCREAMING_SNAKE_CASE constant (`V_` before a leading digit). */
export function screaming(raw: string): string {
  const id = toCase(raw, 'SCREAMING_SNAKE_CASE').replace(/[^A-Z0-9_]/g, '_');
  if (id === '') return 'VALUE';
  return /^[0-9]/.test(id) ? `V_${id}` : id;
}

/** `opts.gemName`, or the title in snake_case (`'Archon Edge Cases'` → `archon_edge_cases`; `api` when nothing is left). */
export function resolveGemName(ir: IRDocument, opts: RubyPluginOptions): string {
  const raw = opts.gemName !== undefined && opts.gemName !== '' ? opts.gemName : toCase(ir.info.title, 'snake_case');
  let name = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[-_]+|[-_]+$/g, '');
  if (name === '') name = 'api';
  return /^[0-9]/.test(name) ? `api_${name}` : name;
}

/** `opts.moduleName` (`'Acme::Api'` nests), or the gem name in PascalCase. */
export function resolveModuleName(gemName: string, opts: RubyPluginOptions): string {
  const raw = opts.moduleName !== undefined && opts.moduleName !== '' ? opts.moduleName : toCase(gemName, 'PascalCase');
  return raw
    .split('::')
    .filter((s) => s !== '')
    .map(constant)
    .join('::') || 'Api';
}

export type RubyNames = {
  /** IR schema name → constant (in the SDK module). */
  types: Map<string, string>;
  /** IR schema name → file path under `lib/<gem>/` (`models/<snake>.rb`). */
  files: Map<string, string>;
  /** Property wire name → member name, for an object schema. */
  members(schemaName: string): Map<string, string>;
  /** Claims another constant of the SDK module (service classes). */
  claim(base: string): string;
  /** Claims a file path under `lib/<gem>/` (`<dir>/<base>.rb`, unique ignoring case). */
  claimFile(dir: string, base: string): string;
};

/**
 * Decides constant names (in `ir.schemas` order) and, lazily, member names per model. Every constant of the SDK
 * module shares one namespace: the module's own constants and `reserved` (service classes) are claimed first.
 */
export function buildNames(ir: IRDocument, opts: RubyPluginOptions, reserved: Iterable<string>): RubyNames {
  const namer = new UniqueNamer([...MODULE_CONSTANTS, ...reserved]);
  const fileNamer = new UniqueNamer(['client', 'auth', 'version', 'core'], { caseInsensitive: true });
  const typeRule = opts.naming.type ?? {};
  const types = new Map<string, string>();
  const files = new Map<string, string>();
  const claimFile = (dir: string, base: string) => {
    const name = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[_.-]+/, '') || 'model';
    return `${dir}/${fileNamer.claim(`${dir}/${name}`).slice(dir.length + 1)}.rb`;
  };
  for (const name of ir.schemas.keys()) {
    const base = opts.hooks.typeName?.(name) ?? applyTemplate(typeRule.name, toCase(name, typeRule.case ?? 'PascalCase'));
    const typeName = namer.claim(constant(base));
    types.set(name, typeName);
    files.set(name, claimFile('models', fileBaseName(typeName, opts)));
  }

  const cache = new Map<string, Map<string, string>>();
  const propertyRule = opts.naming.property ?? {};
  const members = (schemaName: string): Map<string, string> => {
    const cached = cache.get(schemaName);
    if (cached) return cached;
    const schema = ir.schemas.get(schemaName);
    const taken = new UniqueNamer();
    const out = new Map<string, string>();
    for (const p of schema?.kind === 'object' ? schema.properties : []) {
      const hooked = opts.hooks.propertyName?.(p.name, { schema: schemaName });
      out.set(p.name, taken.claim(rubyIdentifier(hooked ?? applyTemplate(propertyRule.name, p.name), propertyRule.case ?? 'snake_case')));
    }
    cache.set(schemaName, out);
    return out;
  };

  return { types, files, members, claim: (base) => namer.claim(constant(base)), claimFile };
}

/** The file base name for a type (`naming.file` / `hooks.fileName`; default snake_case). */
export function fileBaseName(typeName: string, opts: RubyPluginOptions): string {
  const rule = opts.naming.file ?? {};
  return opts.hooks.fileName?.(typeName) ?? applyTemplate(rule.name, toCase(typeName, rule.case ?? 'snake_case'));
}
