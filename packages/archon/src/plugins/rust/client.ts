import type { IRDocument, IROAuthFlows, IRSecurityScheme } from '../../ir/types.js';
import type { PluginContext } from '../../plugin/types.js';
import { UniqueNamer } from '../../writer/naming.js';
import { defaultBaseUrl } from '../csharp/client.js';
import { doc, literal, rsWriter } from './emit.js';
import type { RustPluginOptions } from './index.js';
import { escapeKeyword, rsIdentifier } from './names.js';
import type { ServiceName } from './services.js';

type Scheme = { name: string; spec: string; value: 'Token' | 'Basic' | 'OAuth2' };

const VALUE_TYPES = { Token: 'TokenValue', Basic: 'BasicValue', OAuth2: 'OAuth2Value' } as const;

/** http-other / mutualTLS are left to `custom_auth`. */
function schemes(ir: IRDocument): Scheme[] {
  return [...ir.securitySchemes].flatMap(([name, scheme]) => {
    const entry = schemeEntry(scheme);
    return entry ? [{ name, ...entry }] : [];
  });
}

function schemeEntry(scheme: IRSecurityScheme): Omit<Scheme, 'name'> | undefined {
  const some = (url: string | undefined) => (url === undefined ? 'None' : `Some(${literal(url)})`);
  switch (scheme.kind) {
    case 'http-bearer':
      return { spec: 'core::SecuritySchemeSpec::HttpBearer', value: 'Token' };
    case 'http-basic':
      return { spec: 'core::SecuritySchemeSpec::HttpBasic', value: 'Basic' };
    case 'apiKey': {
      const where = scheme.in === 'header' ? 'Header' : scheme.in === 'query' ? 'Query' : 'Cookie';
      return { spec: `core::SecuritySchemeSpec::ApiKey { location: core::ApiKeyLocation::${where}, name: ${literal(scheme.name)} }`, value: 'Token' };
    }
    case 'oauth2':
      return {
        spec: `core::SecuritySchemeSpec::OAuth2 { token_url: ${some(firstFlowValue(scheme.flows, 'tokenUrl'))}, refresh_url: ${some(firstFlowValue(scheme.flows, 'refreshUrl'))} }`,
        value: 'OAuth2',
      };
    case 'openIdConnect':
      return { spec: 'core::SecuritySchemeSpec::OpenIdConnect', value: 'OAuth2' };
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

/** `src/client.rs`: the client, its builder and the security scheme table. */
export function renderClient(ctx: PluginContext<RustPluginOptions>, services: ServiceName[]): string {
  const client = ctx.options.clientName;
  const builder = `${client}Builder`;
  const w = rsWriter(ctx);
  w.line('use crate::core;');
  if (services.length > 0) w.line('use crate::services;');
  w.blank();
  doc(w, `Client for ${ctx.ir.info.title}. Cloning it is cheap: clones share the connection pool, middleware and tokens.`);
  w.line('#[derive(Debug, Clone)]');
  w.block(`pub struct ${client} {`, () => w.line('core: std::sync::Arc<core::ApiClientCore>,'));
  w.blank();
  w.block(`impl ${client} {`, () => {
    w.line('/// The first server of the API description.');
    w.line(`pub const DEFAULT_BASE_URL: &'static str = ${literal(defaultBaseUrl(ctx.ir))};`);
    w.blank();
    w.line('/// A client with the default settings.');
    w.block('pub fn new() -> Self {', () => w.line('Self::builder().build()'));
    w.blank();
    w.block(`pub fn builder() -> ${builder} {`, () => w.line(`${builder}::new()`));
    w.blank();
    w.line('/// A client from runtime options (an empty `base_url` is the [`Self::DEFAULT_BASE_URL`]).');
    w.block('pub fn from_options(mut options: core::ClientOptions) -> Self {', () => {
      w.block('if options.base_url.is_empty() {', () => w.line('options.base_url = Self::DEFAULT_BASE_URL.to_owned();'));
      w.line('Self { core: std::sync::Arc::new(core::ApiClientCore::new(options, SECURITY_SCHEMES)) }');
    });
    w.blank();
    w.line('/// Sends operation calls; use it for requests the generated services do not cover.');
    w.block('pub fn core(&self) -> &std::sync::Arc<core::ApiClientCore> {', () => w.line('&self.core'));
    w.blank();
    w.line('/// Appends a middleware (inside those already registered, outside authentication).');
    w.block('pub fn use_middleware(&self, middleware: impl core::Middleware + \'static) -> &Self {', () => {
      w.line('self.core.use_middleware(std::sync::Arc::new(middleware));');
      w.line('self');
    });
    for (const s of services) {
      w.blank();
      w.line(`/// The operations of the \`${s.group.replace(/`/g, '')}\` group.`);
      w.block(`pub fn ${s.accessor}(&self) -> services::${s.struct} {`, () => w.line(`services::${s.struct}::new(self.core.clone())`));
    }
  });
  w.blank();
  w.block(`impl Default for ${client} {`, () => {
    w.block('fn default() -> Self {', () => w.line('Self::new()'));
  });
  w.blank();
  w.line(`/// Settings of an [\`${client}\`].`);
  w.line('#[derive(Debug, Clone)]');
  w.block(`pub struct ${builder} {`, () => w.line('options: core::ClientOptions,'));
  w.blank();
  w.block(`impl ${builder} {`, () => {
    w.block('pub fn new() -> Self {', () => {
      w.line(`Self { options: core::ClientOptions { base_url: ${client}::DEFAULT_BASE_URL.to_owned(), ..core::ClientOptions::default() } }`);
    });
    const setter = (docText: string, signature: string, body: string) => {
      w.blank();
      w.line(`/// ${docText}`);
      w.block(`pub fn ${signature} -> Self {`, () => {
        w.line(body);
        w.line('self');
      });
    };
    setter(
      'Absolute base URL; its path is kept (`https://x.test/api/` + `/foo` → `https://x.test/api/foo`).',
      'base_url(mut self, base_url: impl Into<String>)',
      'self.options.base_url = base_url.into();',
    );
    setter('Credentials per security scheme.', 'auth(mut self, auth: crate::ApiAuth)', 'self.options.auth = Some(std::sync::Arc::new(auth));');
    setter('A header sent with every request.', 'header(mut self, name: impl Into<String>, value: impl Into<String>)', 'self.options.headers.set(name, value);');
    setter(
      'Time allowed until the final response headers arrive (redirects included; reading the body is not timed).',
      'timeout(mut self, timeout: std::time::Duration)',
      'self.options.timeout = Some(timeout);',
    );
    setter(
      'Appends a middleware (the first one registered runs outermost).',
      "middleware(mut self, middleware: impl core::Middleware + 'static)",
      'self.options.middleware.push(std::sync::Arc::new(middleware));',
    );
    setter(
      'The reqwest client to send with. Build it with [`core::http_client_builder`] (redirects disabled): the SDK follows redirects itself and drops credentials when the origin changes.',
      'http_client(mut self, client: reqwest::Client)',
      'self.options.http_client = Some(client);',
    );
    setter(
      'Called last when applying authentication; also satisfies schemes the generator could not model.',
      "custom_auth(mut self, auth: impl core::CustomAuth + 'static)",
      'self.options.custom_auth = Some(std::sync::Arc::new(auth));',
    );
    w.blank();
    w.block(`pub fn build(self) -> ${client} {`, () => w.line(`${client}::from_options(self.options)`));
  });
  w.blank();
  w.block(`impl Default for ${builder} {`, () => {
    w.block('fn default() -> Self {', () => w.line('Self::new()'));
  });
  w.blank();
  const entries = schemes(ctx.ir);
  if (entries.length === 0) {
    w.line("static SECURITY_SCHEMES: &[(&str, core::SecuritySchemeSpec)] = &[];");
  } else {
    w.block("static SECURITY_SCHEMES: &[(&str, core::SecuritySchemeSpec)] = &[", () => {
      for (const s of entries) w.line(`(${literal(s.name)}, ${s.spec}),`);
    }, '];');
  }
  return w.toString();
}

/** `src/auth.rs`: typed credentials keyed by security scheme. */
export function renderAuth(ctx: PluginContext<RustPluginOptions>): string {
  const namer = new UniqueNamer(['get']);
  const props = schemes(ctx.ir).map((s) => ({ ...s, field: escapeKeyword(namer.claim(rsIdentifier(s.name, 'snake_case'))) }));
  const w = rsWriter(ctx);
  w.line('use crate::core;');
  w.blank();
  w.line('/// Credentials per security scheme; unset schemes are not applied.');
  w.line('#[derive(Debug, Clone, Default)]');
  if (props.length === 0) {
    w.line('pub struct ApiAuth {}');
  } else {
    w.block('pub struct ApiAuth {', () => {
      for (const p of props) {
        w.line(`/// Security scheme \`${p.name.replace(/`/g, '')}\`.`);
        w.line(`pub ${p.field}: Option<core::${VALUE_TYPES[p.value]}>,`);
      }
    });
  }
  w.blank();
  w.block('impl core::AuthConfig for ApiAuth {', () => {
    if (props.length === 0) {
      w.block("fn get(&self, _scheme: &str) -> Option<core::AuthValue<'_>> {", () => w.line('None'));
      return;
    }
    w.block("fn get(&self, scheme: &str) -> Option<core::AuthValue<'_>> {", () => {
      w.block('match scheme {', () => {
        for (const p of props) w.line(`${literal(p.name)} => self.${p.field}.as_ref().map(core::AuthValue::${p.value}),`);
        w.line('_ => None,');
      });
    });
  });
  return w.toString();
}

/** `src/lib.rs`: the crate root. */
export function renderLib(ctx: PluginContext<RustPluginOptions>): string {
  const client = ctx.options.clientName;
  const w = rsWriter(ctx);
  const info = ctx.ir.info;
  doc(w, [`Client for ${info.title} (${info.version}).`, info.description].filter((s) => s !== undefined && s !== '').join('\n\n'), true);
  w.blank();
  w.line('// The generated code refers to deprecated items itself; callers still see the deprecation.');
  w.line('#![allow(deprecated)]');
  w.line('// Names, argument lists and doc comments follow the API description.');
  w.line('#![allow(non_camel_case_types, non_snake_case)]');
  w.line(
    '#![allow(clippy::too_many_arguments, clippy::large_enum_variant, clippy::enum_variant_names, clippy::should_implement_trait, clippy::type_complexity)]',
  );
  w.line('#![allow(clippy::doc_lazy_continuation, clippy::doc_overindented_list_items, clippy::tabs_in_doc_comments, clippy::empty_docs)]');
  w.blank();
  w.line('mod auth;');
  w.line('mod client;');
  w.line('pub mod core;');
  w.line('pub mod models;');
  w.line('pub mod services;');
  w.blank();
  w.line('pub use crate::auth::ApiAuth;');
  w.line(`pub use crate::client::{${client}, ${client}Builder};`);
  return w.toString();
}
