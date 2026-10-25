import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IRSecurityScheme } from '../../../src/ir/types.js';
import { doc, file, generate, int, json, obj, operation, prop, ref, response, squash, str } from './helpers.js';

const runtimeSrc = fileURLToPath(new URL('../../../../../runtimes/rust/src', import.meta.url));

function api() {
  const securitySchemes = new Map<string, IRSecurityScheme>([
    ['bearerAuth', { kind: 'http-bearer' }],
    ['basic', { kind: 'http-basic' }],
    ['apiKey', { kind: 'apiKey', in: 'query', name: 'api_key' }],
    ['oauth2', { kind: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', refreshUrl: '/oauth/refresh', scopes: {} } } }],
    ['oidc', { kind: 'openIdConnect', url: 'https://id.test/.well-known' }],
    ['digest', { kind: 'http-other', scheme: 'digest' }],
  ]);
  return doc(
    { Pet: obj([prop('id', int, true), prop('name', str)]) },
    [
      operation('GET /pets', 'listPets', { group: 'pets', responses: [response(200, [json(ref('Pet'))])] }),
      operation('GET /core', 'getCore', { group: 'core', responses: [response(204)] }),
      operation('GET /type', 'getType', { group: 'type', responses: [response(204)] }),
      operation('GET /health', 'health', { responses: [response(204)] }),
    ],
    {
      info: { title: 'Pet Store', version: '2026.10.1', description: 'Pets "and" more.' },
      servers: [{ url: 'https://{env}.pets.test/v1', variables: { env: { default: 'api' } } }],
      securitySchemes,
    },
  );
}

describe('rust plugin: client', () => {
  it('emits the client with the default base URL, accessors and the scheme table', async () => {
    const client = squash(file((await generate(api())).files, 'src/client.rs'));
    expect(client).toContain(squash('use crate::core; use crate::services;'));
    expect(client).toContain(squash('#[derive(Debug, Clone)] pub struct ApiClient { core: std::sync::Arc<core::ApiClientCore>, }'));
    expect(client).toContain(squash(`pub const DEFAULT_BASE_URL: &'static str = "https://api.pets.test/v1";`));
    expect(client).toContain(squash('pub fn pets(&self) -> services::PetsService { services::PetsService::new(self.core.clone()) }'));
    expect(client).toContain(squash('pub fn core_api(&self) -> services::CoreService'));
    expect(client).toContain(squash('pub fn r#type(&self) -> services::TypeService'));
    expect(client).toContain(squash('pub fn default_api(&self) -> services::DefaultService'));
    expect(client).toContain(squash('pub fn auth(mut self, auth: crate::ApiAuth) -> Self { self.options.auth = Some(std::sync::Arc::new(auth)); self }'));
    expect(client).toContain(
      squash(`static SECURITY_SCHEMES: &[(&str, core::SecuritySchemeSpec)] = &[
        ("bearerAuth", core::SecuritySchemeSpec::HttpBearer),
        ("basic", core::SecuritySchemeSpec::HttpBasic),
        ("apiKey", core::SecuritySchemeSpec::ApiKey { location: core::ApiKeyLocation::Query, name: "api_key" }),
        ("oauth2", core::SecuritySchemeSpec::OAuth2 { token_url: Some("/oauth/token"), refresh_url: Some("/oauth/refresh") }),
        ("oidc", core::SecuritySchemeSpec::OpenIdConnect),
      ];`),
    );
    expect(file((await generate(api())).files, 'src/services/mod.rs')).toContain('pub mod core2;\npub mod type_;');
  });

  it('emits ApiAuth with a value per supported scheme', async () => {
    const auth = squash(file((await generate(api())).files, 'src/auth.rs'));
    expect(auth).toContain(
      squash(`#[derive(Debug, Clone, Default)] pub struct ApiAuth {
        /// Security scheme \`bearerAuth\`. pub bearer_auth: Option<core::TokenValue>,
        /// Security scheme \`basic\`. pub basic: Option<core::BasicValue>,
        /// Security scheme \`apiKey\`. pub api_key: Option<core::TokenValue>,
        /// Security scheme \`oauth2\`. pub oauth2: Option<core::OAuth2Value>,
        /// Security scheme \`oidc\`. pub oidc: Option<core::OAuth2Value>, }`),
    );
    expect(auth).toContain(squash('"basic" => self.basic.as_ref().map(core::AuthValue::Basic),'));
    expect(auth).not.toContain('digest');
    const none = squash(file((await generate(doc({}))).files, 'src/auth.rs'));
    expect(none).toContain(squash("pub struct ApiAuth {} impl core::AuthConfig for ApiAuth { fn get(&self, _scheme: &str) -> Option<core::AuthValue<'_>> { None } }"));
  });

  it('emits lib.rs re-exporting the client and allowing what generated names need', async () => {
    const lib = file((await generate(api(), { clientName: 'PetClient' })).files, 'src/lib.rs');
    expect(lib).toContain('//! Client for Pet Store (2026.10.1).\n//!\n//! Pets "and" more.\n');
    expect(lib).toContain('#![allow(deprecated)]');
    expect(lib).toContain('pub mod core;\npub mod models;\npub mod services;\n');
    expect(lib).toContain('pub use crate::client::{PetClient, PetClientBuilder};');
  });

  it('emits Cargo.toml with package metadata and extra dependencies', async () => {
    const { files } = await generate(api(), {
      package: { license: 'MIT', authors: ['Natsuneko'], repository: 'https://github.test/x', dependencies: ['chrono = { version = "0.4", features = ["serde"] }'] },
    });
    const cargo = file(files, 'Cargo.toml');
    expect(cargo).toContain('# Generated header\n\n[package]\nname = "pet-store"\nversion = "2026.10.1"\nedition = "2021"\nrust-version = "1.88"\n');
    expect(cargo).toContain('description = "Pets \\"and\\" more."\nlicense = "MIT"\nauthors = ["Natsuneko"]\nrepository = "https://github.test/x"\n');
    expect(cargo).toContain('reqwest = { version = "0.13.5", default-features = false }\n');
    expect(cargo).toContain('serde_json = { version = "1.0.154", features = ["preserve_order"] }\n');
    expect(cargo).toContain('tokio = { version = "1.54.1", features = ["time", "sync"] }\nchrono = { version = "0.4", features = ["serde"] }\n');
    expect(cargo).toContain('[features]\ndefault = ["rustls"]\n');
  });

  it('falls back to 0.1.0 for a version that is not semver, and skips Cargo.toml with package false', async () => {
    const ir = api();
    ir.info.version = 'v2';
    const { files, diagnostics } = await generate(ir);
    expect(file(files, 'Cargo.toml')).toContain('version = "0.1.0"');
    expect(diagnostics.entries.map((d) => d.code)).toContain('invalid-version');
    const skipped = await generate(api(), { package: false });
    expect(skipped.files.has('Cargo.toml')).toBe(false);
    expect(skipped.files.has('src/lib.rs')).toBe(true);
  });

  it('copies the runtime under src/core with crate paths rewritten', async () => {
    const { files } = await generate(api());
    const copied = [...files.keys()].filter((f) => f.startsWith('src/core/')).map((f) => f.slice('src/core/'.length)).sort();
    const expected = readdirSync(runtimeSrc).filter((f) => f.endsWith('.rs')).map((f) => (f === 'lib.rs' ? 'mod.rs' : f)).sort();
    expect(copied).toEqual(expected);
    const mod = file(files, 'src/core/mod.rs');
    expect(mod.startsWith('// Generated header\n')).toBe(true);
    expect(mod).toContain('pub use crate::core::client::ApiClientCore;');
    expect(file(files, 'src/core/client.rs')).not.toMatch(/\bcrate::(?!core::)/);
  });

  it('exposes the generated type names', async () => {
    const { api: symbols } = await generate(api());
    expect(symbols.symbols.typeOf('Pet')).toEqual({ name: 'Pet', path: 'crate::models::Pet', file: 'src/models/pet.rs' });
    expect(() => symbols.symbols.typeOf('Nope')).toThrow(/Unknown schema/);
  });
});
