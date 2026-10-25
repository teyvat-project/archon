import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { defaultBaseUrl } from '../csharp/client.js';
import type { Row } from './align.js';
import { goSource, goString, writeRows } from './emit.js';
import type { GoPluginOptions } from './index.js';
import { exported, goIdentifier } from './names.js';
import type { ServiceName } from './services.js';

type Scheme = { name: string; spec: string; value: 'core.TokenProvider' | 'core.BasicProvider' | '*core.OAuth2' };

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
      return { spec: '{Kind: core.SchemeHTTPBearer}', value: 'core.TokenProvider' };
    case 'http-basic':
      return { spec: '{Kind: core.SchemeHTTPBasic}', value: 'core.BasicProvider' };
    case 'apiKey': {
      const where = scheme.in === 'header' ? 'Header' : scheme.in === 'query' ? 'Query' : 'Cookie';
      return { spec: `{Kind: core.SchemeAPIKey, In: core.APIKeyIn${where}, Name: ${goString(scheme.name)}}`, value: 'core.TokenProvider' };
    }
    case 'oauth2': {
      const tokenUrl = firstFlowValue(scheme.flows, 'tokenUrl');
      const refreshUrl = firstFlowValue(scheme.flows, 'refreshUrl');
      const urls = [
        ...(tokenUrl !== undefined ? [`TokenURL: ${goString(tokenUrl)}`] : []),
        ...(refreshUrl !== undefined ? [`RefreshURL: ${goString(refreshUrl)}`] : []),
      ];
      return { spec: `{${['Kind: core.SchemeOAuth2', ...urls].join(', ')}}`, value: '*core.OAuth2' };
    }
    case 'openIdConnect':
      return { spec: '{Kind: core.SchemeOpenIDConnect}', value: '*core.OAuth2' };
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

/** `client.go`: DefaultBaseURL, ClientOptions, Client and NewClient. */
export function renderClient(ctx: PluginContext<GoPluginOptions>, packageName: string, module: string, services: ServiceName[]): string {
  const w = ctx.writer({ indent: '\t' });
  w.line("// DefaultBaseURL is the API's first server, with its variables at their defaults.");
  w.line(`const DefaultBaseURL = ${goString(defaultBaseUrl(ctx.ir))}`);
  w.blank();
  w.line('// ClientOptions configures a Client; Auth takes an *Auth.');
  w.line('type ClientOptions = core.Options');
  w.blank();
  w.line(`// Client is the client for ${ctx.ir.info.title.replace(/\s+/g, ' ')}.`);
  const fieldRows: Row[] = [['client', '*core.Client'], ...services.map((s): Row => [s.field, `*${s.typeName}`])];
  w.block('type Client struct {', () => writeRows(w, fieldRows));
  w.blank();
  w.line('// NewClient returns a client; an empty BaseURL means DefaultBaseURL.');
  w.block('func NewClient(options ClientOptions) *Client {', () => {
    w.block('if options.BaseURL == "" {', () => w.line('options.BaseURL = DefaultBaseURL'));
    w.line('c := core.NewClient(options, securitySchemes)');
    const rows: Row[] = [['client:', 'c,'], ...services.map((s): Row => [`${s.field}:`, `&${s.typeName}{client: c},`])];
    w.block('return &Client{', () => writeRows(w, rows));
  });
  w.blank();
  w.line('// Core returns the runtime client, for requests the generated services do not cover.');
  w.block('func (c *Client) Core() *core.Client {', () => w.line('return c.client'));
  w.blank();
  w.line('// Use appends a middleware (inside those already registered, outside authentication).');
  w.block('func (c *Client) Use(middleware core.Middleware) *Client {', () => {
    w.line('c.client.Use(middleware)');
    w.line('return c');
  });
  w.blank();
  const entries = schemes(ctx.ir);
  if (entries.length === 0) {
    w.line('var securitySchemes = map[string]core.SecuritySchemeSpec{}');
  } else {
    w.block('var securitySchemes = map[string]core.SecuritySchemeSpec{', () =>
      writeRows(w, entries.map((s): Row => [`${goString(s.name)}:`, `${s.spec},`])),
    );
  }
  return goSource(ctx, packageName, module, w.toString());
}

/** `auth.go`: typed credentials keyed by security scheme. */
export function renderAuth(ctx: PluginContext<GoPluginOptions>, packageName: string, module: string): string {
  const namer = new UniqueNamer(['Get'], { caseInsensitive: true });
  const props = schemes(ctx.ir).map((s) => ({ ...s, field: namer.claim(exported(goIdentifier(s.name, 'PascalCase'))) }));
  const w = ctx.writer({ indent: '\t' });
  w.line('// Auth holds the credentials per security scheme; nil fields are not applied.');
  const rows: Row[] = props.flatMap((p): Row[] => [`// ${p.field} is the credential of the security scheme ${goString(p.name)}.`, [p.field, p.value]]);
  w.block('type Auth struct {', () => writeRows(w, rows));
  w.blank();
  w.line('// Get returns the credential configured for a security scheme (Auth implements core.AuthConfig).');
  w.block('func (a *Auth) Get(scheme string) any {', () => {
    w.block('if a == nil {', () => w.line('return nil'));
    if (props.length > 0) {
      w.line('switch scheme {');
      for (const p of props) {
        w.line(`case ${goString(p.name)}:`);
        // A nil *core.OAuth2 stored in `any` would not be nil.
        w.indent(() => w.block(`if a.${p.field} != nil {`, () => w.line(`return a.${p.field}`)));
      }
      w.line('}');
    }
    w.line('return nil');
  });
  return goSource(ctx, packageName, module, w.toString());
}
