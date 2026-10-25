import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSwiftRuntime, runtimeTypeNames } from '../../../src/plugins/swift/runtime.js';
import { doc, file, generate, operation, response, source, squash } from './helpers.js';

const withAuth = () =>
  doc({}, [operation('GET /a', 'getA', { group: 'options', responses: [response(204)] }), operation('GET /b', 'getB', { group: 'Echo', responses: [response(204)] })], {
    servers: [{ url: 'https://{region}.api.test/{version}', variables: { region: { default: 'eu' }, version: { default: 'v2' } } }],
    securitySchemes: new Map([
      ['bearerAuth', { kind: 'http-bearer' }],
      ['basic', { kind: 'http-basic' }],
      ['key', { kind: 'apiKey', in: 'cookie', name: 'session' }],
      ['oauth', { kind: 'oauth2', flows: { clientCredentials: { tokenUrl: '/token', scopes: {} } } }],
      ['oidc', { kind: 'openIdConnect', url: 'https://id.test/.well-known' }],
      ['digest', { kind: 'http-other', scheme: 'digest' }],
    ]),
  });

describe('swift plugin: client', () => {
  it('emits the client with the default base URL, security schemes and services', async () => {
    const { files } = await generate(withAuth());
    const client = source(files, 'ApiClient.swift');
    expect(client).toContain('public final class ApiClient: Sendable {');
    expect(client).toContain('public static let defaultBaseUrl = "https://eu.api.test/v2"');
    expect(squash(client)).toContain(
      squash(`public static let securitySchemes: [String: SecuritySchemeSpec] = [
        "bearerAuth": .httpBearer,
        "basic": .httpBasic,
        "key": .apiKey(.cookie, name: "session"),
        "oauth": .oauth2(tokenUrl: "/token", refreshUrl: nil),
        "oidc": .openIdConnect,
      ]`),
    );
    // `options` is a client member, so that group's property gets a suffix.
    expect(client).toContain('public let options2: OptionsService');
    expect(client).toContain('public let echo: EchoService');
    expect(client).toContain('echo = EchoService(core: core)');
    expect(client).toContain('baseUrl: String = ApiClient.defaultBaseUrl,');
    expect(client).toContain('public func use(_ middleware: any Middleware) -> ApiClient {');
  });

  it('emits ApiAuth with a value type per scheme kind', async () => {
    const { files } = await generate(withAuth());
    const auth = source(files, 'ApiAuth.swift');
    expect(auth).toContain('public struct ApiAuth: AuthConfig {');
    expect(auth).toContain('public var bearerAuth: TokenValue?');
    expect(auth).toContain('public var basic: BasicValue?');
    expect(auth).toContain('public var key: TokenValue?');
    expect(auth).toContain('public var oauth: OAuth2Value?');
    expect(auth).toContain('public var oidc: OAuth2Value?');
    expect(auth).not.toContain('digest');
    expect(auth).toContain('case "oauth": return oauth.map(AuthValue.oauth2)');
    expect(auth).toContain('public init(bearerAuth: TokenValue? = nil, basic: BasicValue? = nil, key: TokenValue? = nil, oauth: OAuth2Value? = nil, oidc: OAuth2Value? = nil) {');
  });

  it('emits Package.swift, the re-export and the runtime target', async () => {
    const { files } = await generate(withAuth(), { moduleName: 'Acme', package: { name: 'AcmeKit' } });
    const manifest = file(files, 'Package.swift');
    expect(manifest.startsWith('// swift-tools-version:6.0\n// Generated header\nimport PackageDescription\n')).toBe(true);
    expect(manifest).toContain('name: "AcmeKit",');
    expect(manifest).toContain('.library(name: "Acme", targets: ["Acme"]),');
    expect(manifest).toContain('.target(name: "AcmeCore"),');
    expect(manifest).toContain('.target(name: "Acme", dependencies: ["AcmeCore"]),');
    expect(file(files, 'Sources/Acme/Exports.swift')).toBe('// Generated header\n\n@_exported import AcmeCore\n');
    const core = file(files, 'Sources/AcmeCore/ApiClientCore.swift');
    expect(core.startsWith('// Generated header\n\nimport Foundation')).toBe(true);
    expect([...files.keys()].filter((f) => f.startsWith('Sources/AcmeCore/')).length).toBeGreaterThan(10);
  });

  it('skips the manifest with package: false', async () => {
    const { files } = await generate(withAuth(), { package: false });
    expect(files.has('Package.swift')).toBe(false);
    expect(files.has('Sources/TestApi/ApiClient.swift')).toBe(true);
  });

  it('emits an empty ApiAuth without schemes', async () => {
    const { files } = await generate(doc({}));
    expect(squash(source(files, 'ApiAuth.swift'))).toContain(squash('public init() { } public func value(for scheme: String) -> AuthValue? { nil }'));
    expect(source(files, 'ApiClient.swift')).toContain('public static let securitySchemes: [String: SecuritySchemeSpec] = [:]');
  });
});

describe('swift plugin: runtime', () => {
  it('reads runtime files by name and lists public type names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-swift-runtime-'));
    try {
      writeFileSync(join(dir, 'B.swift'), 'public struct Beta {}\nstruct Hidden {}\npublic final class Gamma: Sendable {}\n');
      writeFileSync(join(dir, 'A.swift'), 'public protocol Alpha {}\npublic typealias Next = Int\npublic actor Delta {}\n');
      writeFileSync(join(dir, 'notes.md'), 'public struct NotSwift {}');
      const files = readSwiftRuntime(dir);
      expect(files.map((f) => f.name)).toEqual(['A.swift', 'B.swift']);
      expect([...runtimeTypeNames(files)].sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma', 'Next']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
