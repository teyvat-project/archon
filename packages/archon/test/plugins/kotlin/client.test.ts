import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, file, generate, obj, operation, prop, response, squash, str } from './helpers.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/kotlin/src/main/kotlin/archon/runtime', import.meta.url));

function withAuth() {
  return doc({ Options: obj([prop('a', str)]) }, [
    operation('GET /a', 'getA', { group: 'catalyst', responses: [response(204)] }),
    operation('GET /b', 'getB', { group: 'options', responses: [response(204)] }),
  ], {
    info: { title: 'Natsuneko Laboratory API', version: '2026.10.23', description: 'The "API".' },
    servers: [{ url: 'https://{env}.api.test:{port}/v1', variables: { env: { default: 'prod' }, port: { default: '8443' } } }],
    securitySchemes: new Map([
      ['bearerAuth', { kind: 'http-bearer' }],
      ['basic', { kind: 'http-basic' }],
      ['apiKey', { kind: 'apiKey', in: 'query', name: 'api_key' }],
      ['oauth2', { kind: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} }, authorizationCode: { refreshUrl: '/oauth/refresh', scopes: {} } } }],
      ['oidc', { kind: 'openIdConnect', url: 'https://id.test/.well-known' }],
      ['digest', { kind: 'http-other', scheme: 'digest' }],
      ['scheme', { kind: 'http-bearer' }],
    ]),
  });
}

const DIR = 'src/main/kotlin/natsunekolaboratoryapi';

describe('kotlin plugin: client, auth and Gradle files', () => {
  it('emits DEFAULT_BASE_URL with server variables expanded, SECURITY_SCHEMES and ApiAuth per scheme kind', async () => {
    const { files } = await generate(withAuth(), { packageName: undefined });
    const client = squash(file(files, `${DIR}/ApiClient.kt`));
    expect(client).toContain('package natsunekolaboratoryapi');
    expect(client).toContain('import natsunekolaboratoryapi.core.ApiClientCore');
    expect(client).toContain('import natsunekolaboratoryapi.services.CatalystService');
    expect(client).toContain('public class ApiClient(public val options: ApiClientOptions = ApiClientOptions()) : AutoCloseable {');
    expect(client).toContain('public constructor(configure: ApiClientOptions.() -> Unit) : this(ApiClientOptions().apply(configure))');
    expect(client).toContain('public val core: ApiClientCore = ApiClientCore(options, SECURITY_SCHEMES)');
    expect(client).toContain('public const val DEFAULT_BASE_URL: String = "https://prod.api.test:8443/v1"');
    expect(client).toContain('public val SECURITY_SCHEMES: Map<String, SecuritySchemeSpec> = mapOf(');
    expect(client).toContain('"bearerAuth" to SecuritySchemeSpec.HttpBearer,');
    expect(client).toContain('"basic" to SecuritySchemeSpec.HttpBasic,');
    expect(client).toContain('"apiKey" to SecuritySchemeSpec.ApiKey(ApiKeyLocation.Query, "api_key"),');
    expect(client).toContain('"oauth2" to SecuritySchemeSpec.OAuth2("/oauth/token", "/oauth/refresh"),');
    expect(client).toContain('"oidc" to SecuritySchemeSpec.OpenIdConnect,');
    expect(client).not.toContain('digest');
    expect(client).toContain('public fun use(middleware: Middleware): ApiClient { core.use(middleware) return this }');
    expect(client).toContain('override fun close() { core.close() }');
    expect(client).toContain('public class ApiClientOptions : ClientOptions() {');
    expect(client).toContain('init { baseUrl = ApiClient.DEFAULT_BASE_URL }');
    expect(client).toContain('public var auth: ApiAuth? = null');
    expect(client).toContain('override val authConfig: AuthConfig? get() = auth');

    const auth = squash(file(files, `${DIR}/ApiAuth.kt`));
    expect(auth).toContain('public class ApiAuth(');
    expect(auth).toContain('public var bearerAuth: TokenValue? = null,');
    expect(auth).toContain('public var basic: BasicValue? = null,');
    expect(auth).toContain('public var apiKey: TokenValue? = null,');
    expect(auth).toContain('public var oauth2: OAuth2Value? = null,');
    expect(auth).toContain('public var oidc: OAuth2Value? = null,');
    expect(auth).toContain('public var scheme2: TokenValue? = null,');
    expect(auth).toContain(') : AuthConfig {');
    expect(auth).toContain('override fun get(scheme: String): Any? = when (scheme) {');
    expect(auth).toContain('"bearerAuth" -> bearerAuth');
    expect(auth).toContain('else -> null');
  });

  it('emits an OAuth2 spec with only a refresh URL by name', async () => {
    const ir = doc({}, [], { securitySchemes: new Map([['o', { kind: 'oauth2', flows: { authorizationCode: { refreshUrl: '/r', scopes: {} } } }]]) });
    expect(file((await generate(ir)).files, 'src/main/kotlin/test/api/ApiClient.kt')).toContain('"o" to SecuritySchemeSpec.OAuth2(refreshUrl = "/r"),');
  });

  it('names services after groups and avoids reserved member names', async () => {
    const { files } = await generate(withAuth(), { packageName: undefined });
    const client = file(files, `${DIR}/ApiClient.kt`);
    expect(client).toContain('public val catalyst: CatalystService = CatalystService(core)');
    expect(client).toContain('public val optionsValue: OptionsService = OptionsService(core)');
    expect(files.has(`${DIR}/models/Options.kt`)).toBe(true);
  });

  it('emits build.gradle.kts and settings.gradle.kts with package metadata and extra dependencies', async () => {
    const { files } = await generate(withAuth(), { packageName: undefined, package: { dependencies: ['org.jetbrains.kotlinx:kotlinx-datetime:0.7.1'] } });
    const build = file(files, 'build.gradle.kts');
    expect(build.startsWith('// Generated header\n')).toBe(true);
    expect(build).toContain('kotlin("jvm") version "2.4.21"');
    expect(build).toContain('kotlin("plugin.serialization") version "2.4.21"');
    expect(build).toContain('`java-library`');
    expect(build).toContain('group = "natsunekolaboratoryapi"');
    expect(build).toContain('version = "2026.10.23"');
    expect(build).toContain('description = "The \\"API\\"."');
    expect(build).toContain('api("io.ktor:ktor-client-core:3.6.0")');
    expect(build).toContain('api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")');
    expect(build).toContain('implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.7.1")');
    expect(build).toContain('explicitApi()');
    expect(build).toContain('jvmTarget.set(JvmTarget.JVM_11)');
    expect(build).toContain('freeCompilerArgs.add("-Xjdk-release=11")');
    expect(build).toContain('sourceCompatibility = JavaVersion.VERSION_11');

    const settings = file(files, 'settings.gradle.kts');
    expect(settings).toContain('rootProject.name = "natsuneko-laboratory-api"');
    expect(squash(settings)).toContain(squash('dependencyResolutionManagement { repositories { mavenCentral() } }'));
    expect(squash(settings)).toContain(squash('pluginManagement { repositories { mavenCentral() gradlePluginPortal() } }'));

    const named = await generate(withAuth(), { package: { group: 'archon.e2e', name: 'edge-cases', version: '9.9.9' } });
    expect(file(named.files, 'build.gradle.kts')).toContain('group = "archon.e2e"');
    expect(file(named.files, 'build.gradle.kts')).toContain('version = "9.9.9"');
    expect(file(named.files, 'settings.gradle.kts')).toContain('rootProject.name = "edge-cases"');
  });

  it('package false skips Gradle files', async () => {
    const { files } = await generate(withAuth(), { package: false });
    expect(files.has('build.gradle.kts')).toBe(false);
    expect(files.has('settings.gradle.kts')).toBe(false);
  });

  it('copies the runtime under core with the package rewritten', async () => {
    const { files } = await generate(withAuth(), { packageName: 'my.sdk', clientName: 'MyClient' });
    const core = [...files.keys()].filter((p) => p.startsWith('src/main/kotlin/my/sdk/core/')).sort();
    expect(core).toEqual(readdirSync(repoRuntime).filter((f) => f.endsWith('.kt')).sort().map((f) => `src/main/kotlin/my/sdk/core/${f}`));
    const clientCore = file(files, 'src/main/kotlin/my/sdk/core/ApiClientCore.kt');
    expect(clientCore.startsWith('// Generated header\n')).toBe(true);
    expect(clientCore).toContain('package my.sdk.core');
    expect(clientCore).not.toContain('archon.runtime');
    expect(file(files, 'src/main/kotlin/my/sdk/MyClient.kt')).toContain('public class MyClientOptions : ClientOptions() {');
  });
});
