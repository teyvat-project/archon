import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import type { TypeScriptPluginOptions } from './index.js';
import { propertyKey, quote } from './types.js';

/** client.gen.ts が export する名前（types.gen.ts の型名と衝突させない）。 */
export const CLIENT_EXPORTS = ['securitySchemes', 'ApiAuth', 'defaultBaseUrl', 'createApiClient', 'client'] as const;

type SchemeEntry = { name: string; spec: string; value: 'TokenValue' | 'BasicValue' | 'OAuth2Value' };

/** `client.gen.ts` の内容。 */
export function renderClient(ctx: PluginContext<TypeScriptPluginOptions>): string {
  const ext = ctx.options.importExtension;
  const schemes = [...ctx.ir.securitySchemes].flatMap(([name, scheme]) => {
    const entry = schemeEntry(name, scheme);
    return entry ? [entry] : [];
  });
  const typeImports = [
    ...new Set(['Client', 'ClientConfig', 'SecuritySchemeSpec', ...schemes.map((s) => s.value)]),
  ].sort();

  const w = ctx.writer();
  w.comment(ctx.headerLines('typescript'), 'line');
  w.blank();
  w.line(`import { createClient } from './core/index${ext}';`);
  w.line(`import type { ${typeImports.join(', ')} } from './core/index${ext}';`);
  w.blank();
  if (schemes.length === 0) {
    w.line('export const securitySchemes = {} as const satisfies Record<string, SecuritySchemeSpec>;');
  } else {
    w.block('export const securitySchemes = {', () => {
      for (const s of schemes) w.line(`${propertyKey(s.name)}: ${s.spec},`);
    }, '} as const satisfies Record<string, SecuritySchemeSpec>;');
  }
  w.blank();
  if (schemes.length === 0) {
    w.line('export type ApiAuth = {};');
  } else {
    w.block('export type ApiAuth = {', () => {
      for (const s of schemes) w.line(`${propertyKey(s.name)}?: ${s.value};`);
    }, '};');
  }
  w.blank();
  w.line(`export const defaultBaseUrl = ${quote(defaultBaseUrl(ctx.ir))};`);
  w.blank();
  w.line('export const createApiClient = (config: Partial<ClientConfig<ApiAuth>> = {}): Client<ApiAuth> =>');
  w.line('  createClient<ApiAuth>({ baseUrl: defaultBaseUrl, securitySchemes, ...config });');
  w.blank();
  w.line('export const client = createApiClient();');
  return w.toString();
}

/** `index.ts` の内容（生成モジュールとランタイムをまとめて再 export する）。 */
export function renderIndex(ctx: PluginContext<TypeScriptPluginOptions>): string {
  const ext = ctx.options.importExtension;
  const w = ctx.writer();
  w.comment(ctx.headerLines('typescript'), 'line');
  w.blank();
  for (const module of ['types.gen', 'sdk.gen', 'client.gen', 'core/index']) {
    w.line(`export * from './${module}${ext}';`);
  }
  return w.toString();
}

/** http-other / mutualTLS はランタイムが扱えないので出力しない（customAuth で対応する）。 */
function schemeEntry(name: string, scheme: IRSecurityScheme): SchemeEntry | undefined {
  switch (scheme.kind) {
    case 'http-bearer':
      return { name, spec: "{ type: 'http', scheme: 'bearer' }", value: 'TokenValue' };
    case 'http-basic':
      return { name, spec: "{ type: 'http', scheme: 'basic' }", value: 'BasicValue' };
    case 'apiKey':
      return {
        name,
        spec: `{ type: 'apiKey', in: ${quote(scheme.in)}, name: ${quote(scheme.name)} }`,
        value: 'TokenValue',
      };
    case 'oauth2': {
      const tokenUrl = firstFlowValue(scheme.flows, 'tokenUrl');
      const refreshUrl = firstFlowValue(scheme.flows, 'refreshUrl');
      const fields = [
        "type: 'oauth2'",
        ...(tokenUrl !== undefined ? [`tokenUrl: ${quote(tokenUrl)}`] : []),
        ...(refreshUrl !== undefined ? [`refreshUrl: ${quote(refreshUrl)}`] : []),
      ];
      return { name, spec: `{ ${fields.join(', ')} }`, value: 'OAuth2Value' };
    }
    case 'openIdConnect':
      return { name, spec: "{ type: 'openIdConnect' }", value: 'OAuth2Value' };
    case 'http-other':
    case 'mutualTLS':
      return undefined;
  }
}

/** clientCredentials → authorizationCode → password の順で最初に見つかった値。 */
function firstFlowValue(flows: IROAuthFlows, key: 'tokenUrl' | 'refreshUrl'): string | undefined {
  for (const flow of [flows.clientCredentials, flows.authorizationCode, flows.password]) {
    const value = flow?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** `servers[0]` の URL を変数の default で展開する（server が無ければ `/`）。 */
function defaultBaseUrl(ir: IRDocument): string {
  const server = ir.servers[0];
  if (!server) return '/';
  return server.url.replace(/\{([^}]+)\}/g, (m, name: string) => server.variables[name]?.default ?? m);
}
