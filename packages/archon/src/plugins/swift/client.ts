import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { block, doc, literal, swiftFile, switchBlock } from './emit.js';
import type { SwiftPluginOptions } from './index.js';
import type { ModelContext } from './models.js';
import { escape, swIdentifier } from './names.js';
import type { ServiceName } from './services.js';

type Scheme = { name: string; spec: string; value: 'TokenValue' | 'BasicValue' | 'OAuth2Value'; auth: 'token' | 'basic' | 'oauth2' };

/** http-other / mutualTLS are left to `customAuth`. */
function schemes(ir: IRDocument): Scheme[] {
  return [...ir.securitySchemes].flatMap(([name, scheme]) => {
    const entry = schemeEntry(scheme);
    return entry ? [{ name, ...entry }] : [];
  });
}

function schemeEntry(scheme: IRSecurityScheme): Omit<Scheme, 'name'> | undefined {
  switch (scheme.kind) {
    case 'http-bearer':
      return { spec: '.httpBearer', value: 'TokenValue', auth: 'token' };
    case 'http-basic':
      return { spec: '.httpBasic', value: 'BasicValue', auth: 'basic' };
    case 'apiKey':
      return { spec: `.apiKey(.${scheme.in}, name: ${literal(scheme.name)})`, value: 'TokenValue', auth: 'token' };
    case 'oauth2': {
      const url = (key: 'tokenUrl' | 'refreshUrl') => {
        const value = firstFlowValue(scheme.flows, key);
        return value === undefined ? 'nil' : literal(value);
      };
      return { spec: `.oauth2(tokenUrl: ${url('tokenUrl')}, refreshUrl: ${url('refreshUrl')})`, value: 'OAuth2Value', auth: 'oauth2' };
    }
    case 'openIdConnect':
      return { spec: '.openIdConnect', value: 'OAuth2Value', auth: 'oauth2' };
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

/** `servers[0]` with variables expanded to their defaults (`/` without servers). */
export function defaultBaseUrl(ir: IRDocument): string {
  const server = ir.servers[0];
  if (!server) return '/';
  return server.url.replace(/\{([^}]+)\}/g, (m, name: string) => server.variables[name]?.default ?? m);
}

/** `Sources/<Module>/<ClientName>.swift`. */
export function renderClient(m: ModelContext, services: ServiceName[]): string {
  const ctx = m.ctx;
  const client = ctx.options.clientName;
  const { std } = m.names;
  const w = swiftFile(ctx, m.imports);
  doc(w, `Client for ${ctx.ir.info.title}.`);
  block(w, `public final class ${client}: Sendable`, () => {
    w.line(`public static let defaultBaseUrl = ${literal(defaultBaseUrl(ctx.ir))}`);
    w.blank();
    const entries = schemes(ctx.ir);
    if (entries.length === 0) {
      w.line(`public static let securitySchemes: [${std('String')}: SecuritySchemeSpec] = [:]`);
    } else {
      w.line(`public static let securitySchemes: [${std('String')}: SecuritySchemeSpec] = [`);
      w.indent(() => entries.forEach((s) => w.line(`${literal(s.name)}: ${s.spec},`)));
      w.line(']');
    }
    w.blank();
    w.line('/// Sends operation calls; use it for requests the generated services do not cover.');
    w.line('public let core: ApiClientCore');
    for (const s of services) w.line(`public let ${escape(s.property)}: ${s.typeName}`);
    w.blank();
    w.line('public convenience init(');
    w.indent(() => {
      w.line(`baseUrl: ${std('String')} = ${client}.defaultBaseUrl,`);
      w.line('auth: ApiAuth? = nil,');
      w.line('headers: ApiHeaders = [:],');
      w.line(`timeout: ${std('Double')}? = nil,`);
      w.line('middleware: [any Middleware] = [],');
      w.line('transport: (any HTTPTransport)? = nil,');
      w.line('customAuth: CustomAuth? = nil');
    });
    block(w, ')', () => {
      w.line(
        'self.init(options: ClientOptions(baseUrl: baseUrl, auth: auth, headers: headers, timeout: timeout, middleware: middleware, transport: transport, customAuth: customAuth))',
      );
    });
    w.blank();
    block(w, 'public init(options: ClientOptions)', () => {
      w.line(`core = ApiClientCore(options: options, securitySchemes: ${client}.securitySchemes)`);
      for (const s of services) w.line(`${escape(s.property)} = ${s.typeName}(core: core)`);
    });
    w.blank();
    w.line('/// Settings read on every request; replacing them takes effect for the next call.');
    block(w, 'public var options: ClientOptions', () => {
      w.line('get { core.options }');
      w.line('set { core.options = newValue }');
    });
    w.blank();
    w.line('/// Appends a middleware (inside those already registered, outside authentication).');
    w.line('@discardableResult');
    block(w, `public func use(_ middleware: any Middleware) -> ${client}`, () => {
      w.line('core.use(middleware)');
      w.line('return self');
    });
  });
  return w.toString();
}

/** `Sources/<Module>/ApiAuth.swift`: typed credentials keyed by security scheme. */
export function renderAuth(m: ModelContext): string {
  const { std } = m.names;
  const entries = schemes(m.ctx.ir);
  const namer = new UniqueNamer(['value', 'init', 'self', 'hashValue']);
  const props = entries.map((s) => ({ ...s, property: namer.claim(swIdentifier(s.name, 'camelCase')) }));
  const w = swiftFile(m.ctx, m.imports);
  w.line('/// Credentials per security scheme; unset schemes are not applied.');
  block(w, 'public struct ApiAuth: AuthConfig', () => {
    for (const p of props) {
      w.line(`/// Security scheme \`${p.name}\`.`);
      w.line(`public var ${escape(p.property)}: ${p.value}?`);
    }
    if (props.length > 0) w.blank();
    block(w, `public init(${props.map((p) => `${escape(p.property)}: ${p.value}? = nil`).join(', ')})`, () => {
      for (const p of props) w.line(`self.${escape(p.property)} = ${escape(p.property)}`);
    });
    w.blank();
    block(w, `public func value(for scheme: ${std('String')}) -> AuthValue?`, () => {
      if (props.length === 0) {
        w.line('nil');
        return;
      }
      switchBlock(w, 'switch scheme', () => {
        for (const p of props) w.line(`case ${literal(p.name)}: return ${escape(p.property)}.map(AuthValue.${p.auth})`);
        w.line('default: return nil');
      });
    });
  });
  return w.toString();
}

/** `Sources/<Module>/Exports.swift`: SDK users get the runtime types with `import <Module>`. */
export function renderExports(ctx: PluginContext<SwiftPluginOptions>, core: string): string {
  const w = ctx.writer({ indent: '    ' });
  w.comment(ctx.headerLines('swift'), 'line');
  w.blank();
  w.line(`@_exported import ${core}`);
  return w.toString();
}
