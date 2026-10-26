import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { defaultBaseUrl } from '../csharp/client.js';
import { headerComment, rbString, rbFile, writeList } from './emit.js';
import type { RubyPluginOptions } from './index.js';
import { rubyIdentifier } from './names.js';
import type { ServiceName } from './services.js';

export type Scheme = { name: string; spec: string; kind: 'token' | 'basic' | 'oauth2'; accessor: string };

/** The security schemes the runtime applies (http-other / mutualTLS are left to `custom_auth`), with their Auth accessors. */
export function schemes(ir: IRDocument): Scheme[] {
  const namer = new UniqueNamer();
  return [...ir.securitySchemes].flatMap(([name, scheme]) => {
    const entry = schemeEntry(scheme);
    return entry ? [{ name, ...entry, accessor: namer.claim(rubyIdentifier(name)) }] : [];
  });
}

function schemeEntry(scheme: IRSecurityScheme): Omit<Scheme, 'name' | 'accessor'> | undefined {
  switch (scheme.kind) {
    case 'http-bearer':
      return { spec: 'Core::SecuritySchemeSpec.new(kind: :http_bearer)', kind: 'token' };
    case 'http-basic':
      return { spec: 'Core::SecuritySchemeSpec.new(kind: :http_basic)', kind: 'basic' };
    case 'apiKey':
      return { spec: `Core::SecuritySchemeSpec.new(kind: :api_key, location: :${scheme.in}, name: ${rbString(scheme.name)})`, kind: 'token' };
    case 'oauth2': {
      const tokenUrl = firstFlowValue(scheme.flows, 'tokenUrl');
      const refreshUrl = firstFlowValue(scheme.flows, 'refreshUrl');
      const urls = [
        ...(tokenUrl !== undefined ? [`token_url: ${rbString(tokenUrl)}`] : []),
        ...(refreshUrl !== undefined ? [`refresh_url: ${rbString(refreshUrl)}`] : []),
      ];
      return { spec: `Core::SecuritySchemeSpec.new(${['kind: :oauth2', ...urls].join(', ')})`, kind: 'oauth2' };
    }
    case 'openIdConnect':
      return { spec: 'Core::SecuritySchemeSpec.new(kind: :open_id_connect)', kind: 'oauth2' };
    default:
      return undefined;
  }
}

/** clientCredentials → authorizationCode → password, the first value found. */
function firstFlowValue(flows: IROAuthFlows, key: 'tokenUrl' | 'refreshUrl'): string | undefined {
  for (const flow of [flows.clientCredentials, flows.authorizationCode, flows.password]) {
    const value = flow?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export const CLIENT_OPTIONS = ['base_url: nil', 'auth: nil', 'headers: {}', 'timeout: nil', 'middleware: []', 'transport: nil', 'custom_auth: nil'];

/** `lib/<gem>/client.rb`: DEFAULT_BASE_URL, SECURITY_SCHEMES, the service readers, `use` and `core`. */
export function renderClient(ctx: PluginContext<RubyPluginOptions>, moduleName: string, services: ServiceName[]): string {
  return rbFile(ctx, moduleName, (w) => {
    w.line(`# The client for ${ctx.ir.info.title.replace(/\s+/g, ' ')}. It is safe to share between threads.`);
    w.block('class Client', () => {
      w.line("# The API's first server, with its variables at their defaults.");
      w.line(`DEFAULT_BASE_URL = ${rbString(defaultBaseUrl(ctx.ir))}`);
      w.blank();
      w.line('# The security schemes the runtime applies, by their names in the spec.');
      const entries = schemes(ctx.ir).map((s) => `${rbString(s.name)} => ${s.spec}`);
      if (entries.length === 0) w.line('SECURITY_SCHEMES = {}.freeze');
      else writeList(w, 'SECURITY_SCHEMES = {', entries, '}.freeze');
      w.blank();
      w.line('# @return [Core::Client] the runtime client, for requests the generated services do not cover');
      w.line('attr_reader :core');
      for (const s of services) {
        w.line(`# @return [${s.className}]`);
        w.line(`attr_reader :${s.reader}`);
      }
      w.blank();
      w.line('# @param base_url [::String, nil] the absolute base URL (DEFAULT_BASE_URL when nil); its path is kept');
      w.line('# @param auth [Auth, ::Hash, nil] the credentials per security scheme');
      w.line('# @param headers [::Hash] headers sent with every request');
      w.line('# @param timeout [::Numeric, nil] seconds allowed until the final response arrives (redirects included)');
      w.line('# @param middleware [::Array] objects responding to `call(request, context, next_)`, outermost first');
      w.line('# @param transport [#call, nil] sends one request (Core::NetHttpTransport when nil)');
      w.line('# @param custom_auth [#call, nil] called with the request and the call context after the built-in authentication');
      w.block(`def initialize(${CLIENT_OPTIONS.join(', ')})`, () => {
        w.line('@core = Core::Client.new(');
        w.indent(() => {
          w.line('base_url: base_url || DEFAULT_BASE_URL, security_schemes: SECURITY_SCHEMES, auth: auth, headers: headers, timeout: timeout,');
          w.line('middleware: middleware, transport: transport, custom_auth: custom_auth,');
        });
        w.line(')');
        for (const s of services) w.line(`@${s.reader} = ${s.className}.new(@core)`);
      }, 'end');
      w.blank();
      w.line('# Appends a middleware (inside those already registered, outside authentication).');
      w.line('#');
      w.line('# @param middleware [#call, nil] an object responding to `call(request, context, next_)`, or nil with a block');
      w.line('# @return [self]');
      w.block('def use(middleware = nil, &block)', () => {
        w.line('@core.use(middleware, &block)');
        w.line('self');
      }, 'end');
    }, 'end');
  });
}

const CREDENTIAL_DOC = {
  token: '::String, #call, nil] a token, or a callable returning one (called on every send)',
  basic: 'Core::Basic, ::Hash, #call, nil] the username and password, or a callable returning them',
  oauth2: 'Core::OAuth2, ::Hash, ::String, nil] an access token, or a grant the runtime runs and caches',
} as const;

/** `lib/<gem>/auth.rb`: the credentials per security scheme. */
export function renderAuth(ctx: PluginContext<RubyPluginOptions>, moduleName: string): string {
  const list = schemes(ctx.ir);
  return rbFile(ctx, moduleName, (w) => {
    w.line('# The credentials per security scheme; nil ones are not applied. They are read on every send, so replacing one');
    w.line('# takes effect on the next request.');
    w.block('class Auth', () => {
      for (const s of list) {
        w.line(`# @return [${CREDENTIAL_DOC[s.kind]} (security scheme ${rbString(s.name)})`);
        w.line(`attr_accessor :${s.accessor}`);
      }
      if (list.length > 0) {
        w.blank();
        w.block(`def initialize(${list.map((s) => `${s.accessor}: nil`).join(', ')})`, () => {
          for (const s of list) w.line(`@${s.accessor} = ${s.accessor}`);
        }, 'end');
        w.blank();
      }
      w.line('# The credential configured for a security scheme (by its name in the spec), or nil.');
      if (list.length === 0) {
        w.line('def [](_scheme) = nil');
        return;
      }
      w.block('def [](scheme)', () => {
        w.line('case scheme.to_s');
        for (const s of list) w.line(`when ${rbString(s.name)} then @${s.accessor}`);
        w.line('end');
      }, 'end');
    }, 'end');
  });
}

/** `lib/<gem>.rb`: the module, its version, the runtime, every model and service, and the error aliases. */
export function renderEntry(ctx: PluginContext<RubyPluginOptions>, gemName: string, moduleName: string, files: string[]): string {
  const w = ctx.writer({ indent: '  ' });
  w.line('# frozen_string_literal: true');
  w.blank();
  w.lines(headerComment(ctx));
  w.blank();
  const segments = moduleName.split('::');
  segments.forEach((segment, i) => w.line(`${'  '.repeat(i)}module ${segment}`));
  segments.forEach((_, i) => w.line(`${'  '.repeat(segments.length - 1 - i)}end`));
  w.blank();
  w.line(`require_relative '${gemName}/version'`);
  w.line(`require_relative '${gemName}/core'`);
  for (const file of files) w.line(`require_relative '${gemName}/${file.replace(/\.rb$/, '')}'`);
  w.blank();
  w.block(`module ${moduleName}`, () => {
    for (const name of ['ApiError', 'TransportError', 'TimeoutError', 'DecodeError', 'AuthError']) w.line(`${name} = Core::${name}`);
  }, 'end');
  return w.toString();
}
