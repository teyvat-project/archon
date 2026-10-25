import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { defaultBaseUrl } from '../csharp/client.js';
import { kdoc, ktSource, literal } from './emit.js';
import type { KotlinPluginOptions } from './index.js';
import { escapeKeyword, ktIdentifier, packageCode } from './names.js';
import type { ServiceName } from './services.js';

type Scheme = { name: string; spec: string; value: 'TokenValue' | 'BasicValue' | 'OAuth2Value' };

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
      return { spec: 'SecuritySchemeSpec.HttpBearer', value: 'TokenValue' };
    case 'http-basic':
      return { spec: 'SecuritySchemeSpec.HttpBasic', value: 'BasicValue' };
    case 'apiKey': {
      const where = scheme.in === 'header' ? 'Header' : scheme.in === 'query' ? 'Query' : 'Cookie';
      return { spec: `SecuritySchemeSpec.ApiKey(ApiKeyLocation.${where}, ${literal(scheme.name)})`, value: 'TokenValue' };
    }
    case 'oauth2': {
      const tokenUrl = firstFlowValue(scheme.flows, 'tokenUrl');
      const refreshUrl = firstFlowValue(scheme.flows, 'refreshUrl');
      const args =
        tokenUrl !== undefined
          ? [literal(tokenUrl), ...(refreshUrl !== undefined ? [literal(refreshUrl)] : [])]
          : refreshUrl !== undefined
            ? [`refreshUrl = ${literal(refreshUrl)}`]
            : [];
      return { spec: `SecuritySchemeSpec.OAuth2(${args.join(', ')})`, value: 'OAuth2Value' };
    }
    case 'openIdConnect':
      return { spec: 'SecuritySchemeSpec.OpenIdConnect', value: 'OAuth2Value' };
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

/** `<ClientName>.kt`: the client and its options. */
export function renderClient(ctx: PluginContext<KotlinPluginOptions>, packageName: string, services: ServiceName[], runtimeNames: Iterable<string>): string {
  const client = ctx.options.clientName;
  const w = ctx.writer({ indent: '    ' });
  kdoc(w, `Client for ${ctx.ir.info.title}.`);
  w.block(`public class ${client}(public val options: ${client}Options = ${client}Options()) : AutoCloseable {`, () => {
    w.line(`public constructor(configure: ${client}Options.() -> Unit) : this(${client}Options().apply(configure))`);
    w.blank();
    w.line('/** Sends operation calls; use it for requests the generated services do not cover. */');
    w.line('public val core: ApiClientCore = ApiClientCore(options, SECURITY_SCHEMES)');
    for (const s of services) {
      w.blank();
      w.line(`public val ${s.property}: ${s.className} = ${s.className}(core)`);
    }
    w.blank();
    w.line('/** Appends a middleware (inside those already registered, outside authentication). */');
    w.block(`public fun use(middleware: Middleware): ${client} {`, () => {
      w.line('core.use(middleware)');
      w.line('return this');
    });
    w.blank();
    w.line('/** Closes the HTTP client the SDK created; an [ClientOptions.httpClient] you passed stays open. */');
    w.block('override fun close() {', () => {
      w.line('core.close()');
    });
    w.blank();
    w.block('public companion object {', () => {
      w.line(`public const val DEFAULT_BASE_URL: String = ${literal(defaultBaseUrl(ctx.ir))}`);
      w.blank();
      const entries = schemes(ctx.ir);
      if (entries.length === 0) {
        w.line('public val SECURITY_SCHEMES: Map<String, SecuritySchemeSpec> = emptyMap()');
      } else {
        w.line('public val SECURITY_SCHEMES: Map<String, SecuritySchemeSpec> = mapOf(');
        w.indent(() => entries.forEach((s) => w.line(`${literal(s.name)} to ${s.spec},`)));
        w.line(')');
      }
    });
  });
  w.blank();
  w.line('/** Settings read on every request. */');
  w.block(`public class ${client}Options : ClientOptions() {`, () => {
    w.line(`init { baseUrl = ${client}.DEFAULT_BASE_URL }`);
    w.blank();
    w.line('/** Credentials per security scheme. */');
    w.line('public var auth: ApiAuth? = null');
    w.blank();
    w.line('override val authConfig: AuthConfig? get() = auth');
  });
  const serviceImports = services.map((s) => `${packageCode(packageName)}.services.${s.className}`);
  return ktSource(ctx, packageName, packageName, runtimeNames, w.toString(), serviceImports);
}

/** `ApiAuth.kt`: typed credentials keyed by security scheme. */
export function renderAuth(ctx: PluginContext<KotlinPluginOptions>, packageName: string, runtimeNames: Iterable<string>): string {
  const entries = schemes(ctx.ir);
  const namer = new UniqueNamer(['get', 'scheme']);
  const props = entries.map((s) => ({ ...s, property: escapeKeyword(namer.claim(ktIdentifier(s.name, 'camelCase'))) }));
  const w = ctx.writer({ indent: '    ' });
  w.line('/** Credentials per security scheme; unset schemes are not applied. */');
  if (props.length === 0) {
    w.block('public class ApiAuth : AuthConfig {', () => {
      w.line('override fun get(scheme: String): Any? = null');
    });
  } else {
    w.line('public class ApiAuth(');
    w.indent(() => {
      for (const p of props) {
        w.line(`/** Security scheme \`${p.name.replace(/`/g, '')}\`. */`);
        w.line(`public var ${p.property}: ${p.value}? = null,`);
      }
    });
    w.block(') : AuthConfig {', () => {
      w.block('override fun get(scheme: String): Any? = when (scheme) {', () => {
        for (const p of props) w.line(`${literal(p.name)} -> ${p.property}`);
        w.line('else -> null');
      });
    });
  }
  return ktSource(ctx, packageName, packageName, runtimeNames, w.toString());
}
