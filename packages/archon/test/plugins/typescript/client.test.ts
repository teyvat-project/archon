import { describe, expect, it } from 'vitest';
import type { IRSecurityScheme } from '../../../src/ir/types.js';
import { file, generate, petstore } from './helpers.js';

describe('typescript plugin: client.gen.ts', () => {
  it('emits securitySchemes, ApiAuth types per scheme kind and defaultBaseUrl with server variables expanded', async () => {
    const ir = petstore();
    ir.servers = [
      {
        url: 'https://{env}.example.test/{version}',
        variables: { env: { default: 'api', enum: ['api', 'staging'] }, version: { default: 'v2' } },
      },
      { url: 'https://other.test', variables: {} },
    ];
    ir.securitySchemes = new Map<string, IRSecurityScheme>([
      ['bearerAuth', { kind: 'http-bearer', bearerFormat: 'JWT' }],
      ['basicAuth', { kind: 'http-basic' }],
      ['api-key', { kind: 'apiKey', in: 'header', name: 'X-API-Key' }],
      [
        'oauth2',
        {
          kind: 'oauth2',
          flows: {
            implicit: { authorizationUrl: 'https://auth.test/authorize', scopes: {} },
            authorizationCode: {
              authorizationUrl: 'https://auth.test/authorize',
              tokenUrl: 'https://auth.test/code-token',
              refreshUrl: 'https://auth.test/refresh',
              scopes: {},
            },
            clientCredentials: { tokenUrl: 'https://auth.test/token', scopes: { read: 'Read' } },
          },
        },
      ],
      ['oidc', { kind: 'openIdConnect', url: 'https://auth.test/.well-known/openid-configuration' }],
      ['digest', { kind: 'http-other', scheme: 'digest' }],
      ['mtls', { kind: 'mutualTLS' }],
    ]);

    const client = file((await generate(ir)).files, 'client.gen.ts');
    expect(client).toBe(
      [
        '// Generated header',
        '',
        "import { createClient } from './core/index.js';",
        "import type { BasicValue, Client, ClientConfig, OAuth2Value, SecuritySchemeSpec, TokenValue } from './core/index.js';",
        '',
        'export const securitySchemes = {',
        "  bearerAuth: { type: 'http', scheme: 'bearer' },",
        "  basicAuth: { type: 'http', scheme: 'basic' },",
        "  'api-key': { type: 'apiKey', in: 'header', name: 'X-API-Key' },",
        "  oauth2: { type: 'oauth2', tokenUrl: 'https://auth.test/token', refreshUrl: 'https://auth.test/refresh' },",
        "  oidc: { type: 'openIdConnect' },",
        '} as const satisfies Record<string, SecuritySchemeSpec>;',
        '',
        'export type ApiAuth = {',
        '  bearerAuth?: TokenValue;',
        '  basicAuth?: BasicValue;',
        "  'api-key'?: TokenValue;",
        '  oauth2?: OAuth2Value;',
        '  oidc?: OAuth2Value;',
        '};',
        '',
        "export const defaultBaseUrl = 'https://api.example.test/v2';",
        '',
        'export const createApiClient = (config: Partial<ClientConfig<ApiAuth>> = {}): Client<ApiAuth> =>',
        '  createClient<ApiAuth>({ baseUrl: defaultBaseUrl, securitySchemes, ...config });',
        '',
        'export const client = createApiClient();',
        '',
      ].join('\n'),
    );
  });

  it('imports only the auth value types it uses and keeps relative server urls', async () => {
    const ir = petstore();
    ir.servers = [{ url: '/', variables: {} }];
    const client = file((await generate(ir, { importExtension: '' })).files, 'client.gen.ts');
    expect(client).toContain("import { createClient } from './core/index';");
    expect(client).toContain("import type { Client, ClientConfig, SecuritySchemeSpec, TokenValue } from './core/index';");
    expect(client).toContain("export const defaultBaseUrl = '/';");
  });

  it('emits empty securitySchemes and ApiAuth when the API has no auth', async () => {
    const ir = petstore();
    ir.securitySchemes = new Map();
    const client = file((await generate(ir)).files, 'client.gen.ts');
    expect(client).toContain('export const securitySchemes = {} as const satisfies Record<string, SecuritySchemeSpec>;');
    expect(client).toContain('export type ApiAuth = {};');
  });
});

describe('typescript plugin: index.ts', () => {
  it('re-exports every generated module with the chosen extension', async () => {
    const { files } = await generate(petstore(), { importExtension: '.ts' });
    expect(file(files, 'index.ts')).toBe(
      [
        '// Generated header',
        '',
        "export * from './types.gen.ts';",
        "export * from './sdk.gen.ts';",
        "export * from './client.gen.ts';",
        "export * from './core/index.ts';",
        '',
      ].join('\n'),
    );
    expect(file(files, 'sdk.gen.ts')).toContain("import { client } from './client.gen.ts';");
  });
});

describe('typescript plugin: package.json / tsconfig.json', () => {
  it('emits package.json with name/version and tsconfig', async () => {
    const { files } = await generate(petstore());
    expect(JSON.parse(file(files, 'package.json'))).toEqual({
      name: 'pet-store-api',
      version: '1.2.3',
      type: 'module',
      exports: { '.': './index.ts' },
    });
    expect(JSON.parse(file(files, 'tsconfig.json'))).toEqual({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
      },
      include: ['**/*.ts'],
    });
  });

  it('fills missing package fields from info and keeps the given ones', async () => {
    const { files } = await generate(petstore(), {
      package: { name: '@acme/pets', description: 'Pets SDK', license: 'MIT' },
    });
    expect(JSON.parse(file(files, 'package.json'))).toEqual({
      name: '@acme/pets',
      version: '1.2.3',
      description: 'Pets SDK',
      license: 'MIT',
      type: 'module',
      exports: { '.': './index.ts' },
    });
  });

  it('adjusts module settings to importExtension', async () => {
    const tsExt = JSON.parse(file((await generate(petstore(), { importExtension: '.ts' })).files, 'tsconfig.json'));
    expect(tsExt.compilerOptions).toMatchObject({
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowImportingTsExtensions: true,
      noEmit: true,
    });
    const none = JSON.parse(file((await generate(petstore(), { importExtension: '' })).files, 'tsconfig.json'));
    expect(none.compilerOptions).toMatchObject({ module: 'ESNext', moduleResolution: 'Bundler', strict: true });
    expect(none.compilerOptions).not.toHaveProperty('allowImportingTsExtensions');
  });

  it('package false skips manifests', async () => {
    const { files } = await generate(petstore(), { package: false });
    expect(files.has('package.json')).toBe(false);
    expect(files.has('tsconfig.json')).toBe(false);
    expect(files.has('index.ts')).toBe(true);
  });
});
