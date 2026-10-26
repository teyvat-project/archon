import type { IRSchema } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { CodeWriter } from '../../writer/code-writer.js';
import { UniqueNamer } from '../../writer/naming.js';
import { schemes } from './client.js';
import { doc, headerComment } from './emit.js';
import type { RubyPluginOptions } from './index.js';
import { enumConstant, memberType, members, unionRbs, withDeprecation, type ModelPlan } from './models.js';
import type { RubyNames } from './names.js';
import type { MethodSignature, ServiceName } from './services.js';
import { isDeclared, type RubyTypeResolver } from './types.js';

const CREDENTIALS = { token: 'Core::token_credentials', basic: 'Core::basic_credentials', oauth2: 'Core::oauth2_credentials' } as const;

type Context = { ctx: PluginContext<RubyPluginOptions>; names: RubyNames; resolver: RubyTypeResolver; plan: ModelPlan };

/** `sig/<gem>.rbs`: the types of the generated code (the runtime's are in `sig/<gem>/core.rbs`). */
export function renderRbs(c: Context, moduleName: string, services: (ServiceName & { methods: MethodSignature[] })[]): string {
  const w = c.ctx.writer({ indent: '  ' });
  w.lines(headerComment(c.ctx));
  w.blank();
  const segments = moduleName.split('::');
  for (let i = 1; i < segments.length; i++) {
    w.line(`module ${segments.slice(0, i).join('::')}`);
    w.line('end');
    w.blank();
  }
  w.block(`module ${moduleName}`, () => {
    w.line('VERSION: ::String');
    w.blank();
    for (const name of ['ApiError', 'TransportError', 'TimeoutError', 'DecodeError', 'AuthError']) w.line(`${name}: singleton(Core::${name})`);
    w.blank();
    renderClient(w, services);
    w.blank();
    renderAuth(c, w);
    for (const service of services) {
      w.blank();
      w.block(`class ${service.className}`, () => {
        w.line('def initialize: (Core::Client client) -> void');
        for (const m of service.methods) w.line(`def ${m.method}: ${m.signature}`);
      }, 'end');
    }
    for (const [schemaName, schema] of c.ctx.ir.schemas) {
      if (!isDeclared(schema)) continue;
      w.blank();
      renderModel(c, w, schemaName, schema);
    }
  }, 'end');
  return w.toString();
}

function renderClient(w: CodeWriter, services: ServiceName[]): void {
  w.block('class Client', () => {
    w.line('DEFAULT_BASE_URL: ::String');
    w.line('SECURITY_SCHEMES: ::Hash[::String, Core::SecuritySchemeSpec]');
    w.line('attr_reader core: Core::Client');
    for (const s of services) w.line(`attr_reader ${s.reader}: ${s.className}`);
    w.line(
      'def initialize: (?base_url: ::String?, ?auth: (Auth | ::Hash[::String | ::Symbol, untyped])?, ?headers: ::Hash[::String | ::Symbol, untyped], ' +
        '?timeout: ::Numeric?, ?middleware: ::Array[Core::middleware], ?transport: Core::_Transport?, ?custom_auth: (^(Core::Request, Core::CallContext) -> void)?) -> void',
    );
    w.line('def use: (?Core::middleware? middleware) ?{ (Core::Request, Core::CallContext, ^(Core::Request) -> Core::Response) -> Core::Response } -> self');
  }, 'end');
}

function renderAuth(c: Context, w: CodeWriter): void {
  const list = schemes(c.ctx.ir);
  w.block('class Auth', () => {
    for (const s of list) w.line(`attr_accessor ${s.accessor}: ${CREDENTIALS[s.kind]}?`);
    if (list.length > 0) w.line(`def initialize: (${list.map((s) => `?${s.accessor}: ${CREDENTIALS[s.kind]}?`).join(', ')}) -> void`);
    w.line('def []: (::String | ::Symbol scheme) -> untyped');
  }, 'end');
}

function renderModel(c: Context, w: CodeWriter, schemaName: string, schema: IRSchema): void {
  const typeName = c.names.types.get(schemaName) as string;
  doc(w, withDeprecation(schema.description, schema.deprecated)?.replace(/^@deprecated/m, 'Deprecated:'));
  if (schema.kind === 'object') {
    const list = members(c, schemaName, schema);
    w.block(`class ${typeName} < ::Data`, () => {
      w.line('include Core::Model');
      w.line('extend Core::Model::ClassMethods');
      for (const m of list) w.line(`attr_reader ${m.name}: ${memberType(m).rbs}`);
      const args = list.map((m) => {
        const type = memberType(m).rbs;
        return m.required && m.tag === undefined ? `${m.name}: ${type}` : `?${m.name}: ${type}`;
      });
      w.line(`def initialize: (${args.join(', ')}) -> void`);
      w.line(`def self.from_json: (Core::json json) -> ${typeName}`);
      w.line(`def self.coerce: (${typeName} | ::Hash[::Symbol | ::String, untyped] value) -> ${typeName}`);
      w.line('               | (nil value) -> nil');
    }, 'end');
  } else if (schema.kind === 'enum') {
    const base = schema.base === 'string' ? '::String' : schema.base === 'integer' ? '::Integer' : '::Numeric';
    w.block(`module ${typeName}`, () => {
      // The constant names are recomputed as the model file writes them.
      const namer = new UniqueNamer(['VALUES']);
      for (const v of schema.values) {
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        w.line(`${namer.claim(enumConstant(v))}: ${base}`);
      }
      w.line(`VALUES: ::Array[${base}]`);
      w.line('def self.known?: (untyped value) -> bool');
    }, 'end');
  } else if (schema.kind === 'union') {
    w.block(`module ${typeName}`, () => {
      w.line('extend Core::Union');
      w.line(`type t = ${unionRbs(c.plan.variants.get(schemaName) ?? [])}`);
      w.line('def self.from_json: (Core::json json) -> t');
    }, 'end');
  }
}

