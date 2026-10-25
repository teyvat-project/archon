# Archon

[![npm](https://img.shields.io/npm/v/@natsuneko-laboratory/archon.svg)](https://www.npmjs.com/package/@natsuneko-laboratory/archon)
[![CI](https://github.com/teyvat-project/Archon/actions/workflows/ci.yml/badge.svg)](https://github.com/teyvat-project/Archon/actions/workflows/ci.yml)

**Archon** generates SDKs with minimal dependencies from OpenAPI 3.0 / 3.1 specs. You configure it once, and it
generates idiomatic clients for **TypeScript, C#, Kotlin, Swift, Rust and Go**.

Each SDK includes a small handwritten runtime that is copied into the output. It handles authentication
(including OAuth2), middleware, retries, safe redirects and typed errors, so the generated code adds as few
dependencies as possible to your project:

| Target         | Platforms                                                     | Runtime dependencies                                                  |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| **TypeScript** | Browsers, Node.js 18+, Bun, Deno, React Native, Cloudflare Workers | none (global `fetch` only)                                       |
| **C#**         | .NET 10 (AOT / trimming friendly)                             | none (BCL only)                                                       |
| **Kotlin**     | JVM 11+, Android                                              | `ktor-client-core`, `kotlinx-serialization-json`                      |
| **Swift**      | Swift 6 on macOS 12+, iOS 15+, tvOS 15+, watchOS 8+, visionOS 1+, Linux | none (Foundation only)                                      |
| **Rust**       | stable Rust 1.88+ (edition 2021), tokio                       | `reqwest`, `serde`, `serde_json`, `tokio`                             |
| **Go**         | Go 1.22+                                                      | none (standard library only)                                          |

## Features

- **OpenAPI 3.0 and 3.1** input from a file, a URL (with optional headers) or an in-memory object.
- **Typed models and operations.** Enums and unions keep unknown values instead of failing, so older clients
  keep working when the API adds new variants.
- **Authentication** from `securitySchemes`: HTTP bearer / basic, API keys (header / query / cookie), and OAuth2 /
  OpenID Connect. OAuth2 supports static tokens, client credentials and refresh tokens, with proactive refresh,
  single-flight token fetching and one retry after a `401`.
- **Onion-style middleware** with built-in logging (credentials are masked), User-Agent, retry (honors
  `Retry-After`) and retry-on-401.
- **Safe redirects.** The runtime follows redirects itself and removes `Authorization`, `Cookie` and API keys
  when the redirect goes to a different origin.
- **Filtering and patching.** Include or exclude operations, tags and schemas; rename schemas; patch the document
  before generation.
- **Plugin architecture.** Each language is a plugin, and you can write your own plugins on top of them.

## Installation

The CLI requires **Node.js 22.19 or later**.

```sh
npm install --save-dev @natsuneko-laboratory/archon
# or
pnpm add -D @natsuneko-laboratory/archon
```

## Quick start

```sh
npx archon init       # creates archon.config.ts in the current directory
npx archon generate   # reads archon.config.ts and writes the SDKs
```

The `archon.config.ts` created by `init`:

```ts
import { defineConfig } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: './openapi.yaml',
  output: {
    path: './sdk',
  },
  plugins: [typescript()],
});
```

Then call your API:

```ts
import { createApiClient, showPetById } from './sdk/typescript/index.js';

const client = createApiClient({ baseUrl: 'https://petstore.example.com/v1' });

const { data, error } = await showPetById({ client, path: { petId: '1' } });
if (error) {
  console.error(error.status, error.body);
} else {
  console.log(data.name);
}
```

To generate SDKs for more languages, add more plugins:

```ts
import { csharp, go, kotlin, rust, swift, typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: './openapi.yaml',
  output: './sdk',
  plugins: [typescript(), csharp(), kotlin(), swift(), rust(), go()],
});
```

## CLI

```sh
archon init                          # create an archon.config.ts template (fails if one already exists)
archon generate                      # load archon.config.{ts,mts,mjs,js,json} and generate
archon generate -c path/to/archon.config.ts
archon generate --plugin typescript  # run only this plugin (and its dependencies); repeatable
archon generate --strict             # fail without writing anything if there is any warning
archon generate --verbose            # also print info diagnostics (e.g. renames caused by name collisions)
```

## Configuration

The config file is loaded with [jiti](https://github.com/unjs/jiti), so you can write it in TypeScript. If you pass an
array to `defineConfig([a, b])`, Archon runs each config as a separate job.

```ts
import { defineConfig } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: 'https://api.example.com/openapi.json', // path | URL | { path, headers? } | OpenAPI object
  output: {
    path: './sdk',
    clean: true, // clear the output directory on every run (default: true)
    header: (ctx) => ctx.defaultValue, // override the header lines written to generated files
    postProcess: [{ command: 'prettier', args: ['--write', '{{path}}'] }],
  },
  parser: {
    filters: {
      // An exact "METHOD /path" match or a "/regex/". If both include and exclude match, exclude wins.
      operations: { include: ['/^GET /pets/'], exclude: ['DELETE /pets/{petId}'] },
      tags: { exclude: ['internal'] },
      // If a schema removed by `schemas` (or `deprecated: false`) is still referenced, the reference becomes
      // `unknown` and a `filter-dangling-ref` warning is reported. An invalid /regex/ is an
      // `invalid-filter-pattern` error.
      schemas: { exclude: ['/^Internal/'] },
    },
    transforms: {
      schemaName: 'Api{{name}}', // a template or (name) => string
    },
  },
  plugins: [
    typescript({
      output: 'ts', // subdirectory of output.path (default: 'typescript')
      dates: 'Date', // convert date-time / date to Date (default: 'string')
      enums: 'union', // 'union' | 'const' | 'enum'
      sdk: { style: 'functions' }, // 'functions' | 'class'
    }),
  ],
});
```

`output` can also be a plain string (`'./sdk'`). `parser` also accepts `patch` (to rewrite the document, schemas or
operations before generation) and `hooks` (`operationName`, `operationGroup` and `inlineSchemaName`).

### Plugin options

All plugin options are optional. All plugins accept the following common options:

| Option                | Description                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `output`              | Subdirectory of `output.path`. Defaults to the language name (`'typescript'`, `'csharp'`, `'kotlin'`, `'swift'`, `'rust'`, `'go'`). |
| `naming`              | `{ case, name }` rules per kind of name (see each language below).                                       |
| `typeMappings`        | Overrides keyed by `'kind:format'` (e.g. `'string:uuid'`) or `'kind'` (e.g. `'integer'`).                 |
| `hooks`               | Callbacks for `typeName`, `methodName`, `typeOverride` and, except in TypeScript, `propertyName` and `fileName`. |
| `include` / `exclude` | Per-plugin operation filters, with the same syntax as `parser.filters`.                                  |

<details>
<summary><strong>TypeScript</strong> — <code>typescript()</code></summary>

| Option            | Default                   | Description                                                                                                                                                                                                                                              |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`         | derived from `info`       | Contents of `package.json` / `tsconfig.json`. `false` skips them.                                                                                                                                                                                         |
| `sdk.style`       | `'functions'`             | `'functions'` generates one function per operation (`getX(options)`). `'class'` generates classes with static methods.                                                                                                                                  |
| `enums`           | `'union'`                 | How named enums are declared: `'union'`, `'const'` or `'enum'`.                                                                                                                                                                                        |
| `dates`           | `'string'`                | `'Date'` converts date-times in successful responses to `Date` (`transformers.gen.ts`). Error bodies are not converted, so dates in error types are always `string`. Shared schemas used in error types are wrapped with `DatesAsString<T>`. |
| `importExtension` | `'.js'`                   | Extension for relative imports in the generated code (`'.ts'` and `''` are also allowed).                                                                                                                                                                   |
| `naming`          | PascalCase / camelCase    | `{ type, method }`.                                                                                                                                                                                                                                      |
| `typeMappings`    | `{}`                      | e.g. `{ 'string:uuid': 'Uuid' }`, mapped to a TypeScript type expression.                                                                                                                                                                                |
| `hooks`           | `{}`                      | `typeName`, `methodName`, `typeOverride`.                                                                                                                                                                                                                |

</details>

<details>
<summary><strong>C#</strong> — <code>csharp()</code></summary>

| Option         | Default                                               | Description                                                                                                         |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `namespace`    | title in PascalCase                                   | Root namespace. The runtime goes in `<namespace>.Core`.                                                              |
| `clientName`   | `'ApiClient'`                                         | Client class name. The options class is `<clientName>Options`.                                                      |
| `package`      | derived from `info`                                   | `.csproj` `name` (PackageId / AssemblyName), `version`, `description`, `authors`, `license`. `false` skips the `.csproj`. |
| `naming`       | types / properties PascalCase, methods `{{name}}Async` | `{ type, method, property, file }`.                                                                                 |
| `typeMappings` | `{}`                                                  | e.g. `{ 'string:uuid': 'string', integer: 'long' }`, mapped to a C# type expression.                                 |
| `hooks`        | `{}`                                                  | `typeName`, `methodName` (returns the base name; the `naming.method` template is applied afterwards), `propertyName`, `fileName`, `typeOverride`. |

</details>

<details>
<summary><strong>Kotlin</strong> — <code>kotlin()</code></summary>

| Option         | Default                                                       | Description                                                                                                                                       |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packageName`  | the title split on `.`, with each part lowercased and stripped to letters and digits | Root package. The runtime is `<packageName>.core`, models are `.models`, services are `.services`.                                                |
| `clientName`   | `'ApiClient'`                                                 | Client class name. The options class is `<clientName>Options`.                                                                                    |
| `package`      | derived from `info`                                           | Gradle `group` (default: `packageName`), `name` (default: title in kebab-case), `version`, `description`, and extra `dependencies` (`implementation(...)`). `false` skips the Gradle files. |
| `naming`       | types PascalCase, methods / properties camelCase              | `{ type, method, property, file }`.                                                                                                               |
| `typeMappings` | `{}`                                                          | e.g. `{ integer: 'Long', 'string:date-time': { type: 'kotlinx.datetime.Instant', serializer: 'kotlinx.datetime.serializers.InstantIso8601Serializer' } }`. A plain string uses `<type>.serializer()`. |
| `hooks`        | `{}`                                                          | `typeName`, `methodName`, `propertyName`, `fileName`, `typeOverride` (a Kotlin type or `{ type, serializer }`).                                    |

</details>

<details>
<summary><strong>Swift</strong> — <code>swift()</code></summary>

| Option         | Default                                        | Description                                                                          |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `moduleName`   | title in PascalCase                            | SDK module and library product name. The runtime module is `<moduleName>Core`.        |
| `clientName`   | `'ApiClient'`                                  | Client class name.                                                                   |
| `package`      | `{ name: moduleName }`                         | `Package.swift` settings. `false` skips the manifest.                                |
| `naming`       | types PascalCase, methods / properties camelCase, files = type name | `{ type, method, property, file }`.                                           |
| `typeMappings` | `{}`                                           | Swift type expressions. They must be `Codable`, `Hashable` and `Sendable`.           |
| `hooks`        | `{}`                                           | `typeName`, `methodName`, `propertyName`, `fileName`, `typeOverride` (a Swift type). |

</details>

<details>
<summary><strong>Rust</strong> — <code>rust()</code></summary>

| Option         | Default                                                              | Description                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientName`   | `'ApiClient'`                                                        | Client struct name. The builder is `<clientName>Builder`.                                                                                                                                                                           |
| `package`      | derived from `info`                                                  | `Cargo.toml` `name` (default: title in kebab-case), `version` (default: `info.version`, or `0.1.0` if it is not semver), `description`, `license`, `authors`, `repository`, and extra `dependencies` (lines added to `[dependencies]` as-is). `false` skips `Cargo.toml`. |
| `naming`       | types PascalCase, methods / fields snake_case, files = snake_case type name | `{ type, method, property, file }`.                                                                                                                                                                                                |
| `typeMappings` | `{}`                                                                 | e.g. `{ integer: 'i32', 'string:date-time': 'chrono::DateTime<chrono::Utc>' }`. Types must implement serde.                                                                                                                         |
| `hooks`        | `{}`                                                                 | `typeName`, `methodName`, `propertyName`, `fileName`, `typeOverride` (a Rust type).                                                                                                                                                  |

</details>

<details>
<summary><strong>Go</strong> — <code>go()</code></summary>

| Option         | Default                                                  | Description                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`       | `packageName`                                            | Module path in `go.mod`. The runtime is imported as `<module>/core`.                                                                                                                                                          |
| `packageName`  | title, lowercased and stripped to letters and digits     | Package name. Models, services and the client all go in this one package.                                                                                                                                                    |
| `package`      | —                                                        | `goVersion` for `go.mod` (default: `1.22`) and extra `dependencies` (`require` lines such as `'github.com/google/uuid v1.6.0'`). `false` skips `go.mod`, so you can put the SDK inside an existing module. In that case, set `module` to the directory's import path. |
| `naming`       | types / methods / fields PascalCase, files `<snake_case>_model` | `{ type, method, property, file }`.                                                                                                                                                                                  |
| `typeMappings` | `{}`                                                     | e.g. `{ 'string:date-time': 'string', 'string:uuid': { type: 'uuid.UUID', import: 'github.com/google/uuid' } }`.                                                                                                             |
| `hooks`        | `{}`                                                     | `typeName`, `methodName`, `propertyName`, `fileName`, `typeOverride` (a Go type or `{ type, import }`).                                                                                                                      |

</details>

## Using the generated SDKs

The examples below use the classic [Petstore](https://github.com/teyvat-project/Archon/blob/main/fixtures/specs/petstore.yaml)
spec (`GET /pets/{petId}` with `operationId: showPetById`, tagged `pets`), and assume that the spec also defines an
HTTP bearer security scheme named `bearerAuth`. Operations are named after their
`operationId`. If there is none, the name is derived from the method and the path (`GET /pets/{petId}` →
`getPetsByPetId`). Operations are grouped into services by their tag.

All SDKs behave the same way:

- **Base URL** defaults to `servers[0]` in the spec.
- **Authentication** is configured per security scheme name. The SDK evaluates the operation's `security`
  requirements in order and applies the first alternative that your configured schemes can satisfy. Operations with
  an optional (`{}`) requirement are sent without credentials when none are configured. If a required scheme is
  missing, the SDK throws an auth error before sending the request. Schemes the SDK cannot handle itself (e.g. HTTP
  digest, `mutualTLS`) produce a warning at generation time and can be handled with a custom auth hook.
- **OAuth2 tokens** are refreshed 30 seconds before they expire. Concurrent fetches share one request, and a `401`
  on a managed token triggers one forced refresh and retry.
- **Middleware** runs outermost-first in registration order. Authentication is always applied innermost, right
  before the transport. Built-in middleware: logging (masks `Authorization`, `Cookie`, `Proxy-Authorization` and API
  keys), User-Agent, retry (idempotent methods only, honors `Retry-After` on 429 / 503), and retry-on-401. Requests
  with a non-replayable streaming body are not retried.
- **Errors** are split into four kinds: API errors (non-2xx, with the typed error body declared for that status),
  transport errors (network failure, timeout, cancellation), decode errors (a 2xx body that cannot be
  deserialized) and auth errors.
- **Enums and unions are forward compatible.** Unknown enum values and unknown union variants are kept, including
  the raw JSON for unions, and are sent back unchanged.

### TypeScript

The output contains `types.gen.ts`, `sdk.gen.ts`, `client.gen.ts`, `index.ts` and the runtime in `core/`.
Path parameters, query parameters and the body are passed as `path`, `query` and `body`.

```ts
import { createApiClient, listPets, showPetById } from './sdk/typescript/index.js';

const client = createApiClient({
  baseUrl: 'https://petstore.example.com/v1', // defaults to servers[0] ('/' if there are no servers)
  auth: { bearerAuth: 'my-token' }, // or () => getToken()
  headers: { 'X-App': 'demo' },
  timeout: 10_000, // milliseconds
});

const { data, error, response } = await showPetById({ client, path: { petId: '1' } });
if (error) {
  console.error(error.status, error.body); // ApiError; body is the typed error body for that status
} else {
  console.log(data.name);
}

// throwOnError: throw on failure and return { data, response } (can also be set on the client)
const { data: pets } = await listPets({ client, query: { limit: 20 }, throwOnError: true });
```

If you omit `client`, the shared client exported from `client.gen.ts` is used. Each call also accepts `signal`
(`AbortSignal`), `baseUrl` and `extensions` (arbitrary values passed to middleware).

If `baseUrl` is relative (a relative `servers` URL such as `/api`, or the default `/` when there are no servers), it
is resolved against `location.href` in browsers. In environments without `location` (Node.js, Workers, etc.) this
throws a `TypeError`, so pass an absolute URL: `createApiClient({ baseUrl: 'https://api.example.com' })`.

A call throws a `TypeError` before sending if a path parameter value is `''`, `.` or `..`, because URL normalization
would send the request to a different path. `allowReserved` applies only to query parameters.

#### Authentication

The keys of `auth` are the `securitySchemes` names from the spec, and their types are generated from it. Each value
is a string or a function that returns one (sync or async).

```ts
createApiClient({
  auth: {
    bearerAuth: 'token', // http bearer
    basicAuth: { username: 'u', password: 'p' }, // http basic
    apiKeyHeader: () => loadKey(), // apiKey (`in` / `name` come from the spec: header, query or cookie)
    oauth2: {
      accessToken: 'token', // a static token
      // or
      clientCredentials: { clientId: 'id', clientSecret: 'secret', scopes: ['read'], tokenUrl: '/oauth/token' },
      // or
      refreshToken: { refreshToken: 'rt', clientId: 'id', onRefreshed: (tokens) => save(tokens) },
    },
  },
});
```

- A relative `tokenUrl` / `refreshUrl` is resolved against the base URL (itself resolved as described above).
  Absolute URLs are used as-is. If it cannot be resolved, an `AuthError` is thrown.
- Use `createApiClient({ customAuth: (req, ctx) => { ... } })` for schemes other than HTTP bearer / basic (e.g. digest)
  and for `mutualTLS`. When `customAuth` is set, those schemes count as configured and `customAuth` is responsible
  for applying them. Without it they throw `AuthError`.
- If an operation's `security` refers to a scheme that is missing from `components.securitySchemes`, an
  `unknown-security-scheme` warning is reported at generation time.

#### Middleware

Register middleware with `createApiClient({ middleware: [...] })` or `client.use(mw)`.

```ts
import { createApiClient, loggingMiddleware, retry401Middleware, retryMiddleware, userAgentMiddleware } from './sdk/typescript/index.js';
import type { Middleware } from './sdk/typescript/index.js';

const timing: Middleware = async (req, next, ctx) => {
  const started = Date.now();
  const res = await next(req);
  console.log(ctx.operationName, res.status, Date.now() - started);
  return res;
};

const client = createApiClient({
  middleware: [
    loggingMiddleware(),
    userAgentMiddleware('my-app/1.0'),
    retryMiddleware({ maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 }),
    retry401Middleware({ onUnauthorized: async () => refreshStaticToken() }), // return true to retry once
    timing,
  ],
});
```

The `CallContext` (`ctx`) contains `operationName`, `method`, `pathTemplate`, `tags`, `security`, `attempt`,
`signal` and `extensions`.

#### Results and errors

Only non-2xx responses are returned as `{ data: undefined, error, response }`, with an `ApiError` in `error`. With
`throwOnError: true` they are thrown too. All other errors are always thrown, whatever the value of `throwOnError`.

| Class            | When                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `ApiError`       | Non-2xx response. Returned by default, thrown with `throwOnError`. `status`, `body` (typed error body), `response`. |
| `TransportError` | Network failure, timeout or cancellation. Always thrown. `timedOut`, `cause`.                |
| `DecodeError`    | A 2xx body could not be deserialized. Always thrown. `raw` (raw body), `response`.           |
| `AuthError`      | A required security scheme is not configured. Always thrown. `schemes`.                      |

#### Supported runtimes

Browsers, Node.js 18+, Bun, Deno, React Native and Cloudflare Workers (ESM only). The SDK uses only the global
`fetch`, `Request`, `Response`, `Headers`, `URL`, `FormData`, `Blob` and `AbortController`. To use a different
`fetch`, pass `createApiClient({ fetch })`. The generated code assumes a consumer tsconfig with `strict: true`,
`target: "ES2022"`, `lib: ["ES2022", "DOM"]` and `module: "NodeNext"`.

#### Known limitations

- In browsers and React Native, removing credentials on cross-origin redirects is best effort, because the platform
  follows redirects itself.
- `timeout` only covers the time until the response headers arrive. Aborting after the headers have arrived does
  not cancel reading the body.
- To narrow a TypeScript discriminated union, the discriminator property must be a literal in the spec (`const` or
  a single-value `enum`).
- The TypeScript plugin does not yet support a `bigint` option for int64, `naming.property` / `hooks.propertyName`,
  or `naming.file` / `hooks.fileName`.

### C#

Targets .NET 10 (`net10.0`) and depends only on the BCL. JSON uses System.Text.Json source generation, so the SDK
works with AOT and trimming.

```text
csharp/
  SwaggerPetstore.csproj      # skipped with package: false
  ApiClient.cs                # ApiClient / ApiClientOptions
  ApiAuth.cs                  # typed auth settings per security scheme
  ApiJsonContext.cs           # JsonSerializerContext
  Models/*.cs                 # one file per schema (inline objects / enums / unions are hoisted as {Parent}{Prop})
  Services/<Group>Service.cs  # one service per tag
  Core/*.cs                   # the runtime
```

```csharp
using SwaggerPetstore;
using SwaggerPetstore.Core;

var client = new ApiClient(new ApiClientOptions
{
    BaseUrl = "https://petstore.example.com/v1",   // defaults to servers[0] (ApiClient.DefaultBaseUrl)
    Auth = new ApiAuth { BearerAuth = "token" },   // a string, or new TokenValue(ct => ...)
    Timeout = TimeSpan.FromSeconds(30),
    Middleware = { new RetryMiddleware(), new UserAgentMiddleware("my-app/1.0") },
});

Pet pet = await client.Pets.ShowPetByIdAsync("1");                  // returns the success body
var result = await client.Pets.ShowPetByIdWithResponseAsync("1");    // StatusCode / Headers / Url / Data
```

- Parameter order: path → required body → required query / header / cookie → optional (`= null`) →
  `RequestOptions? requestOptions` → `CancellationToken`. Use named arguments for optional parameters.
- Non-2xx responses always throw. `ApiException<T>` has a typed `Body` when the status has a declared body (looked up
  as `404` → `4XX` → `default`). Otherwise, or if the body is malformed, `ApiException` is thrown (`StatusCode`,
  `Headers`, `RawBody`, `Url`). Network failures and timeouts throw `ApiTransportException` (`TimedOut`). 2xx decode
  failures throw `ApiDecodeException` (`RawBody`). A missing required scheme throws `ApiAuthException` (`Schemes`)
  before sending. Caller cancellation throws `OperationCanceledException`.
- Auth: set the `ApiAuth` properties (the scheme names in PascalCase). Bearer / API keys take `TokenValue`, basic takes
  `BasicValue`, and OAuth2 / OpenID Connect take `OAuth2Value { AccessToken | ClientCredentials | RefreshToken }`.
  Use `ClientOptions.CustomAuth` for unsupported schemes.
- Middleware: implement `IApiMiddleware` (`InvokeAsync(request, next, context, cancellationToken)`) or use
  `ApiMiddleware.Create((req, next, ctx, ct) => ...)`. Add it to `Middleware` or call `client.Use(...)`. Built-in:
  `LoggingMiddleware`, `UserAgentMiddleware`, `RetryMiddleware`, `Retry401Middleware`.
- If you pass your own `HttpClient` (`ClientOptions.HttpClient`), configure its handler with
  `AllowAutoRedirect = false` and `UseCookies = false`.

**Type mapping:** `date-time` → `DateTimeOffset`, `date` → `DateOnly`, `uuid` → `Guid`, `int64` → `long` (`int` for
integers without a format), `binary` → `ApiFile` (`byte[]` or `Stream` plus a file name), unknown schemas →
`JsonElement`. Required properties use `required`, and optional / nullable properties use `T?`.

- **Enums** are structs that keep unknown values (`Status.Active`, `status.Value`, `status.IsKnown`). In a `switch`,
  match on `status.Value` or compare with `==`.
- **Discriminated unions** are a `[JsonPolymorphic]` base class with derived classes (`shape is Circle c`). An
  unknown discriminator value produces an instance of the base type, with the other properties in
  `AdditionalProperties` (System.Text.Json does not keep the discriminator value itself). Request bodies declared as
  a variant type are serialized through the base type, so the discriminator is sent. Model properties declared as a
  variant type do not get the discriminator. When a variant cannot be a derived class (e.g. it belongs to several
  unions), and for **non-discriminated unions**, the union is a wrapper class with `Value`, one accessor per variant
  (`pet.Cat`) and `Unknown` (raw JSON). The variants are tried in declaration order, and the first one that parses is
  used.
- Optional properties that are `null` are not sent. Telling "unset" apart from "null" is not supported. Empty JSON
  responses (e.g. 204) return `null` (`default`).

### Kotlin

Targets JVM 11+ and Android. It depends only on `io.ktor:ktor-client-core` and
`org.jetbrains.kotlinx:kotlinx-serialization-json` (both as `api`). You choose the HTTP engine (CIO or OkHttp on the
JVM, OkHttp or Android on Android). Serializers are referenced explicitly per type instead of being looked up by
reflection, so the SDK works with R8 / ProGuard without extra rules.

```text
kotlin/
  build.gradle.kts, settings.gradle.kts   # skipped with package: false (no Gradle wrapper is included)
  src/main/kotlin/swaggerpetstore/
    ApiClient.kt                          # ApiClient / ApiClientOptions
    ApiAuth.kt                            # typed auth settings per security scheme
    models/*.kt                           # one file per schema
    services/<Group>Service.kt            # one service per tag (suspend functions)
    core/*.kt                             # the runtime (package <packageName>.core)
```

```kotlin
import swaggerpetstore.ApiAuth
import swaggerpetstore.ApiClient
import swaggerpetstore.core.RetryMiddleware
import swaggerpetstore.core.TokenValue
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlin.time.Duration.Companion.seconds

val client = ApiClient {
    baseUrl = "https://petstore.example.com/v1"      // defaults to servers[0] (ApiClient.DEFAULT_BASE_URL)
    httpClient = HttpClient(CIO)                     // if omitted, uses the engine found on the classpath
    auth = ApiAuth(bearerAuth = TokenValue("token")) // or TokenValue { fetchToken() } (called for every request)
    timeout = 30.seconds
    middleware.add(RetryMiddleware())
}

val pet = client.pets.showPetById("1")                   // returns the success body
val result = client.pets.showPetByIdWithResponse("1")    // statusCode / headers / url / data
client.close()  // closes only an HttpClient the SDK created itself
```

- Parameter order: path → required body → required query / header / cookie → optional (`= null`) →
  `requestOptions: RequestOptions? = null`. Use named arguments for optional parameters. Operations without content
  return `Unit`.
- Non-2xx responses always throw `ApiException` (`statusCode`, `headers`, `rawBody`, `url`). Read a declared error
  body with `error.bodyAs<NotFoundError>()`. Kotlin exceptions cannot be generic, so unlike C# the exception class
  has no type parameter. Network failures and timeouts throw `ApiTransportException` (`timedOut`). 2xx decode
  failures throw `ApiDecodeException` (`rawBody`). A missing required scheme throws `ApiAuthException` (`schemes`)
  before sending. Coroutine cancellation propagates as `CancellationException`.
- Auth: set the `ApiAuth` properties (the scheme names in camelCase). Bearer / API keys take `TokenValue`, basic takes
  `BasicValue`, and OAuth2 / OpenID Connect take `OAuth2Value(accessToken | clientCredentials | refreshToken)`.
  Cancelling one call does not cancel a token fetch that other calls share. Use `customAuth` for unsupported
  schemes.
- Middleware: `Middleware { request, next, context -> next(request) }` (a `fun interface`). Add it to `middleware` or
  call `client.use(...)`. Built-in: `LoggingMiddleware`, `UserAgentMiddleware`, `RetryMiddleware`,
  `Retry401Middleware`.
- The SDK uses the `HttpClient` you pass through a derived client
  (`config { followRedirects = false; expectSuccess = false }`), so your client can have any redirect or
  `expectSuccess` setting. `client.close()` does not close an `HttpClient` you passed in.

**Type mapping:** `date-time` / `date` / `uuid` / `uri` / `byte` → `String` (change it with `typeMappings`), `int64`
→ `Long` (`Int` for integers without a format), `binary` → `ApiFile` (`ByteArray` plus file name and Content-Type),
unknown schemas → `JsonElement`. Optional properties are `T? = null`. Required nullable properties are `T?` with no
default.

- **Enums** are classes that keep unknown values (`Status.Active`, `status.value`, `status.isKnown`,
  `Status.knownValues`). An `enum class` could not send unknown values back. For forward compatibility, `when`
  needs an `else` branch.
- **Unions** are `sealed interface`s. A named object variant's data class implements the interface itself
  (`data class Cat(…) : Pet`; one class can implement several unions). Other variants are nested wrappers
  (`Pet.StringValue(value)`, `Pet.CatList(value)`). Discriminated unions pick the variant from the discriminator.
  Non-discriminated unions try the variants in declaration order and use the first one that parses. Anything else
  becomes `Pet.Unknown(raw)` with the raw JSON. The discriminator property stays on the variant and has the tag as
  its default value (`Circle(radius = 1.0)`).
- Optional properties that are `null` are not sent. An empty success response (e.g. 204) for a non-null declared
  type throws `ApiDecodeException`. If the schema is nullable, the result is `null`.
- Additional properties are not kept on objects that also declare properties. Objects with no declared properties
  become `Map<String, T>`.

Build the generated SDK with your own Gradle setup.

### Swift

A SwiftPM package for Swift 6 (tools version 6.0, Swift 6 language mode) that depends only on Foundation
(`FoundationNetworking` on Linux). It runs on macOS 12, iOS 15, tvOS 15, watchOS 8, visionOS 1 or later, and on Linux.
All public types are `Sendable`.

```text
swift/
  Package.swift                          # skipped with package: false
  Sources/<Module>/ApiClient.swift        # ApiClient
  Sources/<Module>/ApiAuth.swift          # typed auth settings per security scheme
  Sources/<Module>/Exports.swift          # @_exported import <Module>Core (import <Module> also exposes runtime types)
  Sources/<Module>/Models/*.swift         # one file per schema
  Sources/<Module>/Services/<Group>Service.swift
  Sources/<Module>Core/*.swift            # the runtime (a separate target, so it never clashes with model names)
```

The module name defaults to `info.title` in PascalCase. Change it with `swift({ moduleName: 'PetstoreKit' })`. Add
the output directory as a path dependency:

```swift
// Package.swift
.package(path: "sdk/swift"),
// in your target's dependencies
.product(name: "SwaggerPetstore", package: "swift"),
```

```swift
import SwaggerPetstore

let client = ApiClient(
    baseUrl: "https://petstore.example.com/v1",   // defaults to servers[0] (ApiClient.defaultBaseUrl)
    auth: ApiAuth(bearerAuth: "token"),           // a string, or TokenValue(provider: { ... })
    timeout: 30,
    middleware: [RetryMiddleware(), UserAgentMiddleware("my-app/1.0")]
)

let pet = try await client.pets.showPetById(petId: "1")                 // returns the success body
let result = try await client.pets.showPetByIdWithResponse(petId: "1")  // statusCode / headers / url / data
```

- Argument labels are the parameter names in camelCase. Order: path → required `body:` → required query / header /
  cookie → optional (`= nil`) → `options: RequestOptions?`.
- Non-2xx responses throw `ApiError` (`statusCode`, `headers`, `url`, `rawBody`). Read a declared error body with
  `error.body(as: NotFoundError.self)`. It is looked up as `404` → `4XX` → `default`, and returns `nil` if the body
  cannot be decoded. Network failures and timeouts throw `TransportError` (`timedOut`). 2xx decode failures throw
  `DecodeError` (`rawBody`). A missing required scheme throws `AuthError` (`schemes`) before sending, and invalid
  arguments such as a missing path parameter throw `ArgumentError`. Task cancellation throws `CancellationError`.
- Auth: set the `ApiAuth` properties (the scheme names in camelCase). Bearer / API keys take `TokenValue`, basic takes
  `BasicValue`, and OAuth2 / OpenID Connect take `OAuth2Value(accessToken:clientCredentials:refreshToken:)`. Token
  fetches are single-flight through an actor. Use `customAuth: { request, context in ... }` for unsupported schemes.
- Middleware: conform to the `Middleware` protocol (`intercept(_:context:next:)`) or use
  `ClosureMiddleware { request, context, next in ... }`. Pass it to `middleware:` or call `client.use(...)`. Built-in:
  `LoggingMiddleware`, `UserAgentMiddleware`, `RetryMiddleware(RetryOptions)`, `Retry401Middleware`.
- Requests go through an `HTTPTransport`. The default is a `URLSessionTransport` with cookies and caching disabled
  that does not follow redirects automatically. To use your own `URLSession`, pass it to
  `URLSessionTransport(session:)`, and give it a delegate that does not follow redirects (return `nil` from
  `willPerformHTTPRedirection`).

**Type mapping:** `date-time` → `Date` (RFC 3339, with fractional seconds and offsets), `date` → `CalendarDate` (a
year-month-day type in the runtime), `uuid` → `UUID`, `int64` → `Int64` (`int32` → `Int32`, `Int` without a format),
`byte` → `Data`, `binary` → `ApiFile` (`Data` plus file name and Content-Type; binary request / response bodies are
`Data`), unknown schemas → `JSONValue`. Optional / nullable properties are `T?`. Models are
`Codable, Hashable, Sendable` structs with a memberwise initializer.

- **Enums** have one case per known value plus `unknown(String)` (`unknown(Int)` / `unknown(Double)` for numeric
  enums), and provide `rawValue`, `isKnown` and `allCases`. Integer cases look like `_1`.
- **Unions** are `indirect enum`s with associated values (`case .circle(let c)`). Discriminated unions pick the
  variant from the discriminator. Non-discriminated unions try the variants in declaration order and use the first
  one that parses. Anything else becomes `unknown(JSONValue)`. The discriminator property stays on the variant
  struct and is the initializer's default value when it is a `const` or a single-value enum (`Circle(radius: 1)`).
- Value types that contain themselves (`Node.parent: Node?`, or `A.b` ↔ `B.a`) store the property in the runtime's
  `Indirect` box. The public API is still a regular property.
- Intentional differences from the other SDKs: `|`, `[` and `]` are always percent-encoded in paths and queries,
  because Foundation's `URL` rejects them (`piped=1%7C2`, `filter%5Bstatus%5D=active`). The server decodes them to
  the same values. An empty JSON response (e.g. 204) is `nil` for optional return types and a `DecodeError`
  otherwise. JSON is encoded with the runtime's `JSONValueEncoder` / `ApiJSON` to keep keys in declaration order
  (`JSONEncoder` does not). Decoding uses `JSONDecoder`.

### Rust

Targets stable Rust 1.88+ (edition 2021; the `url` / `icu_*` dependencies require 1.88). It depends on `reqwest`
(`default-features = false`), `serde`, `serde_json` (`preserve_order`) and `tokio` (`time` and `sync` only). Select
TLS with features: `rustls` by default, or `--no-default-features --features native-tls`. The SDK expects a tokio
runtime but never spawns tasks itself.

```text
rust/
  Cargo.toml                  # skipped with package: false
  src/
    lib.rs                    # pub use ApiClient / ApiClientBuilder / ApiAuth
    client.rs  auth.rs        # client and builder, typed auth settings per security scheme
    models/*.rs               # one file per schema (re-exported, e.g. models::Pet)
    services/<group>.rs       # one service per tag, a request builder and an error enum per operation
    core/*.rs                 # the runtime
```

```rust
use std::time::Duration;

use swagger_petstore::core::{RetryMiddleware, TokenValue};
use swagger_petstore::{ApiAuth, ApiClient};

let client = ApiClient::builder()
    .base_url("https://petstore.example.com/v1")       // defaults to servers[0] (ApiClient::DEFAULT_BASE_URL)
    .auth(ApiAuth { bearer_auth: Some("token".into()), ..Default::default() }) // or TokenValue::provider(|| async { fetch_token().await })
    .timeout(Duration::from_secs(30))
    .middleware(RetryMiddleware::new())
    .build();

let pet = client.pets().show_pet_by_id("1").await?;          // ApiResponse<Pet>: status / headers / url / data
let pets = client.pets().list_pets().limit(20).send().await?; // optional parameters are builder setters
```

- Required parameters (path → required body → required query / header / cookie) are method arguments
  (`impl Into<T>`). Optional parameters are setters on the request builder with the same name. Send a request with
  `.await` (`IntoFuture`) or `.send().await`. Use `.request_options(RequestOptions::new().header(…))` for per-call
  headers, extensions and base URL. Cloning `ApiClient` is cheap, and clones share the connection pool, middleware
  and tokens.
- Results are `Result<ApiResponse<T>, core::Error<E>>`. Non-2xx responses are `Error::Api` (`status`, `headers`,
  `url`, `raw_body`, `body`). `body` holds the operation's error enum (`ShowPetByIdError::Default(Error)`,
  `Status404(...)`, `Status4xx(...)`), but only when the body decodes as declared. Operations with no declared errors
  have `E = ()`. Network failures and timeouts are `Error::Transport` (`timed_out`). 2xx decode failures are
  `Error::Decode` (`raw_body`). A missing required scheme is `Error::Auth` (`schemes`) before sending. Requests that
  cannot be built (a missing required path parameter, a header containing CR / LF, a relative base URL) are
  `Error::InvalidRequest`. To cancel a request, drop its future.
- Auth: set the `ApiAuth` fields (the scheme names in snake_case). Bearer / API keys take `TokenValue`, basic takes
  `BasicValue`, and OAuth2 / OpenID Connect take `OAuth2Value` (`access_token` / `client_credentials` /
  `refresh_token`). Use `custom_auth` for unsupported schemes.
- Middleware: implement the `core::Middleware` trait or use
  `middleware_fn(|req, ctx, next| Box::pin(async move { next.run(req).await }))`. Register it with the builder's
  `middleware(...)` or call `client.use_middleware(...)`. `next` is `Copy`, so it can be called more than once.
  Built-in: `LoggingMiddleware`, `UserAgentMiddleware`, `RetryMiddleware`, `Retry401Middleware`.
- A `reqwest::Client` cannot be reconfigured after it is built. If you pass your own, create it from
  `core::http_client_builder()` (redirects disabled). If you pass a client that follows redirects, you get reqwest's
  own behavior: it removes `Authorization` / `Cookie` but keeps API keys.

**Type mapping:** `date-time` / `date` / `uuid` / `uri` / `byte` → `String` (switch to `chrono` / `uuid` with
`typeMappings` and `package.dependencies`), `int64` and integers without a format → `i64` (`int32` → `i32`), `float` →
`f32`, other numbers → `f64`, `binary` → `ApiFile` (`Vec<u8>` plus file name and Content-Type), unknown schemas →
`serde_json::Value`, `additionalProperties` → `HashMap<String, T>`, optional / nullable → `Option<T>`. Reserved words
become raw identifiers such as `r#type` (`self_` for `self` and similar). Types that contain themselves without a
`Vec<T>` in between are boxed (`Box<T>`).

- **Enums** have an `Unknown(…)` variant (`Status::Active`, `status.as_str()` / `priority.value()`, `is_known()`,
  `KNOWN_VALUES`, `From<&str>`). Unknown values can be sent back unchanged. Compare enums by value.
- **Discriminated unions** are enums that pick the variant from the discriminator (`Shape::Circle(Circle)`).
  **Non-discriminated unions** are `#[serde(untagged)]` enums that try the variants in declaration order and use the
  first one that parses. Anything else becomes `Unknown(serde_json::Value)` and is written back unchanged. The
  discriminator property stays on the variant struct (`Circle { kind: "circle".into(), .. }`).
- Optional properties that are `None` are not sent. An empty success response (e.g. 204) for a non-`Option` type is
  an `Error::Decode`.
- The runtime builds multipart bodies itself instead of using reqwest's `multipart`, so the same body can be resent
  on retries, redirects and 401 retries.

Use the generated SDK as a Cargo path or git dependency.

### Go

Targets Go 1.22+ and depends only on the standard library. The output is already gofmt-formatted and passes
`go vet`.

```text
go/
  go.mod                  # skipped with package: false
  client.go               # Client / ClientOptions / NewClient / DefaultBaseURL
  auth.go                 # typed auth settings per security scheme (Auth)
  <name>_model.go         # one file per schema (all in the same package)
  <group>_service.go      # one service per tag, plus <Method>Params
  core/*.go               # the runtime (package core)
```

```go
import (
	"example.com/petstore"
	"example.com/petstore/core"
)

client := petstore.NewClient(petstore.ClientOptions{
	BaseURL:    "https://petstore.example.com/v1",      // defaults to servers[0] (petstore.DefaultBaseURL)
	HTTPClient: &http.Client{Transport: myTransport},   // defaults to http.DefaultTransport
	Auth:       &petstore.Auth{BearerAuth: core.StaticToken("token")},
	Timeout:    30 * time.Second,
	Middleware: []core.Middleware{core.Retry(core.RetryOptions{})},
})

pet, resp, err := client.Pets.ShowPetById(ctx, petstore.ShowPetByIdParams{PetId: "1"})
```

(Here the plugin is configured with `go({ module: 'example.com/petstore', packageName: 'petstore' })`.)

- Every operation takes `ctx context.Context` first. Operations with parameters then take a `<Method>Params` struct
  (required parameters are values; optional ones are `*T`, slices or maps; `core.Ptr(v)` makes a pointer).
  Operations with a body take it next (required bodies are values; optional bodies are `*T`, and `nil` sends no
  body). The last argument is `opts ...core.RequestOption` (`core.WithHeader`, `core.WithBaseURL`,
  `core.WithExtension`).
- Operations return `(T, *http.Response, error)`, or `(*http.Response, error)` if they have no content. Object and
  union models are returned as `*T`, and everything else (slices, scalars, enums) by value. A 204 or empty body
  returns the zero value for types that allow it. The `*http.Response` body is already read into memory and can be
  read any number of times, and `Request.URL` is the final URL. The `*http.Response` is returned for non-2xx
  responses too.
- Use `errors.As` to inspect errors. Non-2xx responses are `*core.APIError` (`StatusCode`, `Header`, `RawBody`, `URL`,
  `Body`). Read a declared error body with `core.ErrorBody[*Error](err)`. Network failures and timeouts are
  `*core.TransportError` (`Timeout`). If the caller's `ctx` was cancelled, `errors.Is(err, context.Canceled)` is
  true. 2xx decode failures are `*core.DecodeError` (`RawBody`). A missing required scheme is `*core.AuthError`
  (`Schemes`) before sending.
- Auth: set the `Auth` fields (the scheme names in PascalCase). Bearer / API keys take a `core.TokenProvider`
  (`core.StaticToken("…")` or `core.TokenFunc(func(ctx) (string, error))`, called for every request). Basic takes
  `core.Basic{Username, Password}` / `core.BasicFunc`, and OAuth2 / OpenID Connect take
  `&core.OAuth2{AccessToken | ClientCredentials | RefreshToken}`. If one caller's `ctx` ends, token fetches that other
  callers share are not cancelled. Use `CustomAuth` for unsupported schemes.
- Middleware: `func(req *core.Request, next core.Next, ctx *core.CallContext) (*core.Response, error)`. List it in
  `ClientOptions.Middleware` or call `client.Use(...)`. Built-in: `core.Logging`, `core.UserAgent`, `core.Retry`,
  `core.Retry401`.
- The SDK uses a shallow copy of the `*http.Client` you pass, with only `CheckRedirect` replaced. Your original
  client is not modified. `NewClient` copies `ClientOptions`, so after that only `client.Use` changes the client.
  `Auth` is a pointer, so if you replace a scheme's value, the next request uses the new one.

**Type mapping:** `date-time` → `time.Time`, `date` → `core.Date` (`YYYY-MM-DD`), `uuid` / `uri` → `string`, `byte` →
`[]byte`, `int64` → `int64` (`int32` → `int32`, `int` without a format), `float` → `float32`, `binary` → `core.File`
(`Content []byte` + `Name` + `ContentType`; create one from an `io.Reader` with `core.ReadFile(r, name, contentType)`.
It is kept in memory so it can be resent), unknown schemas → `json.RawMessage`.

- **Enums** are named types with constants (`type Status string`, `StatusActive`, `status.IsKnown()`). Unknown values
  are kept and sent back unchanged.
- **Unions** are structs with one pointer per variant plus `Raw` (`Shape{Circle: &Circle{Radius: 1}}`; after
  decoding, check `shape.Circle != nil`). Discriminated unions pick the variant from the discriminator.
  Non-discriminated unions try the variants in declaration order and use the first one that parses. Anything else is
  kept in `Raw` and written back unchanged. The discriminator property stays on the variant, and `MarshalJSON` fills
  in the tag when it is empty.
- `UnmarshalJSON` checks objects with required properties for missing values (and for `null` in non-nullable
  required properties), because `encoding/json` does not. Optional properties are `omitempty`, so `nil` and empty
  slices are not sent. Required object references are values. If a type contains itself only through values, the
  reference becomes a pointer.
- Additional properties are not kept on objects that also declare properties. Objects with no declared properties
  become `map[string]T`.

## Custom plugins

Create plugins with `definePlugin`. A plugin can depend on other plugins and use their public API. For example, the
TypeScript plugin's `symbols` gives you the generated type and function names.

```ts
import { defineConfig, definePlugin } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';
import type { TypeScriptPluginAPI } from '@natsuneko-laboratory/archon/plugins';

const operationList = definePlugin<{ output: string }>({
  name: 'operation-list',
  dependencies: ['typescript'], // run after the typescript plugin
  factories: { typescript }, // added with default options if it is missing from the config
  defaults: { output: 'operation-list' },
  generate(ctx) {
    const ts = ctx.plugin<TypeScriptPluginAPI>('typescript');
    const lines = ctx.ir.operations.map((op) => `${op.id} -> ${ts.symbols.operation(op.id).functionName}`);
    ctx.emit('operations.txt', `${lines.join('\n')}\n`); // relative to the plugin's output directory
  },
});

export default defineConfig({
  input: './openapi.yaml',
  output: './sdk',
  plugins: [typescript(), operationList()],
});
```

A `PluginDefinition` can also have `transformIR(ir, ctx)`, which modifies the IR before any plugin's `generate`
runs, and `irRequirements`, which controls hoisting of inline objects and enums. `ctx` provides `ir`, `options`,
`config`, `diagnostics`, `emit`, `writer()` (a `CodeWriter`), `headerLines(language)` and `plugin(name)`.

## Roadmap

- [x] Core (loader, parser, IR, passes, config, plugin API, CLI)
- [x] TypeScript
- [x] C# (.NET 10)
- [x] Kotlin (JVM 11+ / Android)
- [x] Swift 6
- [x] Rust
- [x] Go 1.22+
- [ ] Ruby 3.2+

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/teyvat-project/Archon). See
[CONTRIBUTING.md](https://github.com/teyvat-project/Archon/blob/main/CONTRIBUTING.md) for how to build and test the
project. The design document is in
[`docs/superpowers/specs`](https://github.com/teyvat-project/Archon/blob/main/docs/superpowers/specs/2026-10-25-archon-design.md)
(in Japanese).

## License

[MIT](https://github.com/teyvat-project/Archon/blob/main/LICENSE)
