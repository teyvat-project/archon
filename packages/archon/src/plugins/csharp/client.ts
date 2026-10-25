import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { block, csFile, G, GEN, literal, summary } from './emit.js';
import type { CSharpPluginOptions } from './index.js';
import { csIdentifier } from './names.js';
import { RESERVED_MEMBERS } from './reserved.js';
import type { ServiceName } from './services.js';

type Scheme = { name: string; spec: string; value: 'TokenValue' | 'BasicValue' | 'OAuth2Value' };

/** http-other / mutualTLS are left to `CustomAuth`. */
function schemes(ir: IRDocument): Scheme[] {
  return [...ir.securitySchemes].flatMap(([name, scheme]) => {
    const entry = schemeEntry(scheme);
    return entry ? [{ name, ...entry }] : [];
  });
}

function schemeEntry(scheme: IRSecurityScheme): Omit<Scheme, 'name'> | undefined {
  switch (scheme.kind) {
    case 'http-bearer':
      return { spec: 'new SecuritySchemeSpec.HttpBearer()', value: 'TokenValue' };
    case 'http-basic':
      return { spec: 'new SecuritySchemeSpec.HttpBasic()', value: 'BasicValue' };
    case 'apiKey': {
      const where = scheme.in === 'header' ? 'Header' : scheme.in === 'query' ? 'Query' : 'Cookie';
      return { spec: `new SecuritySchemeSpec.ApiKey(ApiKeyLocation.${where}, ${literal(scheme.name)})`, value: 'TokenValue' };
    }
    case 'oauth2': {
      const tokenUrl = firstFlowValue(scheme.flows, 'tokenUrl');
      const refreshUrl = firstFlowValue(scheme.flows, 'refreshUrl');
      const args = refreshUrl !== undefined ? [tokenUrl === undefined ? 'null' : literal(tokenUrl), literal(refreshUrl)] : tokenUrl !== undefined ? [literal(tokenUrl)] : [];
      return { spec: `new SecuritySchemeSpec.OAuth2(${args.join(', ')})`, value: 'OAuth2Value' };
    }
    case 'openIdConnect':
      return { spec: 'new SecuritySchemeSpec.OpenIdConnect()', value: 'OAuth2Value' };
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

/** `<ClientName>.cs`: the client and its options. */
export function renderClient(ctx: PluginContext<CSharpPluginOptions>, namespace: string, services: ServiceName[]): string {
  const client = ctx.options.clientName;
  const w = csFile(ctx, namespace, [`${namespace}.Core`]);
  summary(w, `Client for ${ctx.ir.info.title}.`);
  block(w, `public sealed partial class ${client}`, () => {
    w.line(`public const string DefaultBaseUrl = ${literal(defaultBaseUrl(ctx.ir))};`);
    w.blank();
    const entries = schemes(ctx.ir);
    w.line(`public static ${GEN}.IReadOnlyDictionary<string, SecuritySchemeSpec> SecuritySchemes { get; } = new ${GEN}.Dictionary<string, SecuritySchemeSpec>`);
    w.line('{');
    w.indent(() => entries.forEach((s) => w.line(`[${literal(s.name)}] = ${s.spec},`)));
    w.line('};');
    w.blank();
    w.line(`public ${client}() : this(new ${client}Options()) { }`);
    w.blank();
    block(w, `public ${client}(${client}Options options)`, () => {
      w.line(`Options = options ?? throw new ${G}.ArgumentNullException(nameof(options));`);
      w.line('Core = new ApiClientCore(options, SecuritySchemes);');
      for (const s of services) w.line(`${s.property} = new ${s.className}(Core);`);
    });
    w.blank();
    w.line('/// <summary>Settings read on every request.</summary>');
    w.line(`public ${client}Options Options { get; }`);
    w.blank();
    w.line('/// <summary>Sends operation calls; use it for requests the generated services do not cover.</summary>');
    w.line('public ApiClientCore Core { get; }');
    for (const s of services) {
      w.blank();
      w.line(`public ${s.className} ${s.property} { get; }`);
    }
    w.blank();
    w.line('/// <summary>Appends a middleware (inside those already registered, outside authentication).</summary>');
    block(w, `public ${client} Use(IApiMiddleware middleware)`, () => {
      w.line('Core.Use(middleware);');
      w.line('return this;');
    });
  });
  w.blank();
  block(w, `public sealed class ${client}Options : ClientOptions<ApiAuth>`, () => {
    block(w, `public ${client}Options()`, () => {
      w.line(`BaseUrl = ${client}.DefaultBaseUrl;`);
    });
  });
  return w.toString();
}

/** `ApiAuth.cs`: typed credentials keyed by security scheme. */
export function renderAuth(ctx: PluginContext<CSharpPluginOptions>, namespace: string): string {
  const entries = schemes(ctx.ir);
  const namer = new UniqueNamer([...RESERVED_MEMBERS, 'ApiAuth', 'Get']);
  const props = entries.map((s) => ({ ...s, property: namer.claim(csIdentifier(s.name, 'PascalCase')) }));
  const w = csFile(ctx, namespace, [`${namespace}.Core`]);
  w.line('/// <summary>Credentials per security scheme; unset schemes are not applied.</summary>');
  block(w, 'public sealed class ApiAuth : IAuthConfig', () => {
    for (const p of props) {
      w.line(`/// <summary>Security scheme <c>${p.name}</c>.</summary>`);
      w.line(`public ${p.value}? ${p.property} { get; set; }`);
      w.blank();
    }
    w.line('object? IAuthConfig.Get(string scheme) => scheme switch');
    w.line('{');
    w.indent(() => {
      for (const p of props) w.line(`${literal(p.name)} => ${p.property},`);
      w.line('_ => null,');
    });
    w.line('};');
  });
  return w.toString();
}
