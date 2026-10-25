import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, file, generate, obj, operation, prop, response, squash, str } from './helpers.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/csharp/src', import.meta.url));

function withAuth() {
  return doc({ Options: obj([prop('a', str)]) }, [
    operation('GET /a', 'getA', { group: 'catalyst', responses: [response(204)] }),
    operation('GET /b', 'getB', { group: 'Options', responses: [response(204)] }),
  ], {
    info: { title: 'Natsuneko Laboratory API', version: '2026.10.23', description: 'The API.' },
    servers: [{ url: 'https://{env}.api.test:{port}/v1', variables: { env: { default: 'prod' }, port: { default: '8443' } } }],
    securitySchemes: new Map([
      ['bearerAuth', { kind: 'http-bearer' }],
      ['basic', { kind: 'http-basic' }],
      ['apiKey', { kind: 'apiKey', in: 'query', name: 'api_key' }],
      ['oauth2', { kind: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} }, authorizationCode: { refreshUrl: '/oauth/refresh', scopes: {} } } }],
      ['oidc', { kind: 'openIdConnect', url: 'https://id.test/.well-known' }],
      ['digest', { kind: 'http-other', scheme: 'digest' }],
    ]),
  });
}

describe('csharp plugin: client, auth and project', () => {
  it('emits DefaultBaseUrl with server variables expanded, SecuritySchemes and ApiAuth per scheme kind', async () => {
    const { files } = await generate(withAuth());
    const client = squash(file(files, 'ApiClient.cs'));
    expect(client).toContain('namespace NatsunekoLaboratoryApi;');
    expect(client).toContain('public sealed partial class ApiClient');
    expect(client).toContain('public const string DefaultBaseUrl = "https://prod.api.test:8443/v1";');
    expect(client).toContain('["bearerAuth"] = new SecuritySchemeSpec.HttpBearer(),');
    expect(client).toContain('["basic"] = new SecuritySchemeSpec.HttpBasic(),');
    expect(client).toContain('["apiKey"] = new SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),');
    expect(client).toContain('["oauth2"] = new SecuritySchemeSpec.OAuth2("/oauth/token", "/oauth/refresh"),');
    expect(client).toContain('["oidc"] = new SecuritySchemeSpec.OpenIdConnect(),');
    expect(client).not.toContain('digest');
    expect(client).toContain('public ApiClient() : this(new ApiClientOptions()) { }');
    expect(client).toContain('public ApiClient Use(IApiMiddleware middleware)');
    expect(client).toContain('public sealed class ApiClientOptions : ClientOptions<ApiAuth>');
    expect(client).toContain('BaseUrl = ApiClient.DefaultBaseUrl;');

    const auth = squash(file(files, 'ApiAuth.cs'));
    expect(auth).toContain('public sealed class ApiAuth : IAuthConfig');
    expect(auth).toContain('public TokenValue? BearerAuth { get; set; }');
    expect(auth).toContain('public BasicValue? Basic { get; set; }');
    expect(auth).toContain('public TokenValue? ApiKey { get; set; }');
    expect(auth).toContain('public OAuth2Value? Oauth2 { get; set; }');
    expect(auth).toContain('public OAuth2Value? Oidc { get; set; }');
    expect(auth).toContain('"bearerAuth" => BearerAuth,');
    expect(auth).toContain('_ => null,');
  });

  it('names services after groups and avoids reserved member names', async () => {
    const { files } = await generate(withAuth());
    const client = squash(file(files, 'ApiClient.cs'));
    expect(client).toContain('public CatalystService Catalyst { get; }');
    expect(client).toContain('Catalyst = new CatalystService(Core);');
    // "Options" is taken by the client's options property; the schema named Options keeps its name
    expect(client).toContain('public OptionsService OptionsValue { get; }');
    expect(files.has('Models/Options.cs')).toBe(true);
  });

  it('emits csproj with package metadata and falls back on invalid versions', async () => {
    const { files } = await generate(withAuth(), { package: { authors: 'natsuneko', license: 'MIT' } });
    const project = file(files, 'NatsunekoLaboratoryApi.csproj');
    expect(project).toContain('<TargetFramework>net10.0</TargetFramework>');
    expect(project).toContain('<Nullable>enable</Nullable>');
    expect(project).toContain('<IsAotCompatible>true</IsAotCompatible>');
    expect(project).toContain('<PackageId>NatsunekoLaboratoryApi</PackageId>');
    expect(project).toContain('<Version>2026.10.23</Version>');
    expect(project).toContain('<Description>The API.</Description>');
    expect(project).toContain('<Authors>natsuneko</Authors>');
    expect(project).toContain('<PackageLicenseExpression>MIT</PackageLicenseExpression>');
    expect(project).not.toContain('PackageReference');

    const ir = withAuth();
    ir.info.version = 'v1-beta';
    const { files: f2, diagnostics } = await generate(ir, { package: { name: 'My.Sdk' } });
    expect(file(f2, 'My.Sdk.csproj')).toContain('<Version>1.0.0</Version>');
    expect(diagnostics.entries.map((d) => d.code)).toContain('csharp-invalid-version');
  });

  it('package false skips csproj', async () => {
    const { files } = await generate(withAuth(), { package: false });
    expect([...files.keys()].some((f) => f.endsWith('.csproj'))).toBe(false);
  });

  it('copies runtime files into Core with the namespace rewritten', async () => {
    const { files } = await generate(withAuth(), { namespace: 'My.Sdk', clientName: 'MyClient' });
    const core = [...files.keys()].filter((p) => p.startsWith('Core/')).sort();
    expect(core).toEqual(readdirSync(repoRuntime).filter((f) => f.endsWith('.cs')).sort().map((f) => `Core/${f}`));
    const clientCore = file(files, 'Core/ApiClientCore.cs');
    expect(clientCore.startsWith('// Generated header\n')).toBe(true);
    expect(clientCore).toContain('namespace My.Sdk.Core;');
    expect(clientCore).not.toContain('Archon.Runtime');
    expect(file(files, 'MyClient.cs')).toContain('public sealed class MyClientOptions : ClientOptions<ApiAuth>');
  });
});
