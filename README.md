# Archon

OpenAPI 3.0 / 3.1 の仕様から、**外部依存を最小化した** SDK を生成するジェネレータ（Meta SDK）です。
設計の詳細は [`docs/superpowers/specs/2026-10-25-archon-design.md`](docs/superpowers/specs/2026-10-25-archon-design.md) を参照してください。

現在は **M1〜M5（コア + TypeScript / C# / Kotlin / Swift / Rust プラグイン）** まで実装済みです。生成される SDK の依存は最小限（TypeScript は `fetch` のみ、
C# は BCL のみ、Kotlin は `ktor-client-core` と `kotlinx-serialization-json` のみ、Swift は Foundation のみ、Rust は `reqwest` / `serde` / `serde_json` /
`tokio` のみ）で、手書きのランタイムは生成物の `core/`（C# は `Core/`、Swift は `Sources/<Module>Core/`、Rust は `src/core/`）にそのままコピーされます。

## インストール

npm にはまだ公開していません。当面はこのリポジトリのワークスペースで開発・利用します（Node.js 24 / pnpm 10）。

```sh
pnpm install
pnpm -F @natsuneko-laboratory/archon build   # CLI (packages/archon/dist/cli.js) を作る
```

公開後は `pnpm add -D @natsuneko-laboratory/archon` で利用する想定です。

## 使い方

### CLI

```sh
archon init                         # カレントディレクトリに archon.config.ts のテンプレートを作る（既存なら失敗）
archon generate                     # archon.config.{ts,mts,mjs,js,json} を読んで生成する
archon generate -c path/to/archon.config.ts
archon generate --plugin typescript # 指定プラグイン（と依存）だけ実行。繰り返し指定可
archon generate --strict            # 警告が 1 件でもあれば何も書き出さずに失敗する
archon generate --verbose           # info レベルの診断（命名衝突の改名など）も表示する
```

ワークスペース内では（先に `pnpm -F @natsuneko-laboratory/archon build` が必要）、`examples/natsuneko` のように `@natsuneko-laboratory/archon` を devDependency に持つパッケージから `pnpm exec archon generate` で実行できます。

```sh
cd examples/natsuneko && pnpm exec archon generate   # → examples/natsuneko/sdk/ts/
```

### 設定ファイル

`archon.config.ts`（ローダーは jiti）。配列を `defineConfig([a, b])` に渡すと複数ジョブになります。

```ts
import { defineConfig } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: 'https://api.natsuneko.com/openapi.json', // パス | URL | { path, headers? } | OpenAPI オブジェクト
  output: {
    path: './sdk',
    clean: true, // 出力先を毎回クリア（既定 true）
    header: (ctx) => ctx.defaultValue, // 生成物ヘッダ（行配列）の上書き
    postProcess: [{ command: 'prettier', args: ['--write', '{{path}}'] }],
  },
  parser: {
    filters: {
      // "METHOD /path" の完全一致、または "/regex/"。include と exclude の両方に一致したら exclude が優先
      operations: { include: ['/^GET /catalyst/'], exclude: ['DELETE /catalyst/v1/blocks'] },
      tags: { exclude: ['activitypub'] },
      // schemas / deprecated: false で除いた schema がまだ参照されていると、その参照は unknown 型になり
      // filter-dangling-ref の警告が出る（不正な /regex/ は invalid-filter-pattern エラー）
      schemas: { exclude: ['/^Internal/'] },
    },
    transforms: {
      schemaName: 'Api{{name}}', // テンプレートまたは (name) => string
    },
  },
  plugins: [
    typescript({
      output: 'ts', // output.path からのサブディレクトリ（既定 'typescript'）
      dates: 'Date', // date-time / date を Date にする（既定 'string'）
      enums: 'union', // 'union' | 'const' | 'enum'
      sdk: { style: 'functions' }, // 'functions' | 'class'
    }),
  ],
});
```

`output` は文字列（`'./sdk'`）でも書けます。`parser` には他に `patch`（document / schemas / operations の書き換え）、
`hooks`（`operationName` / `operationGroup` / `inlineSchemaName`）があります。

TypeScript プラグインの主なオプション（すべて任意）:

| オプション | 既定 | 内容 |
|---|---|---|
| `output` | `'typescript'` | 出力サブディレクトリ |
| `package` | info から導出 | `package.json` / `tsconfig.json` の情報。`false` で生成しない |
| `sdk.style` | `'functions'` | `getX(options)` 関数、または `class`（static メソッド） |
| `enums` | `'union'` | named enum の宣言形式 |
| `dates` | `'string'` | `'Date'` にすると成功応答の日時を `Date` に変換する（`transformers.gen.ts`）。エラーボディは変換されないので、エラー型の日時は常に `string`（共有 schema は `DatesAsString<T>` で包む） |
| `importExtension` | `'.js'` | 生成コードの相対 import の拡張子（`'.ts'` / `''` も可） |
| `naming` | PascalCase / camelCase | `{ type, method }` ごとに `{ case, name }` |
| `typeMappings` | `{}` | `'string:uuid': 'Uuid'` のような `kind:format` → TS 型式の上書き |
| `hooks` | `{}` | `typeName` / `methodName` / `typeOverride` |
| `include` / `exclude` | なし | プラグイン単位の操作フィルタ（`parser.filters` と同じ構文） |

C# プラグイン（`csharp()`）の主なオプション（すべて任意）:

| オプション | 既定 | 内容 |
|---|---|---|
| `output` | `'csharp'` | 出力サブディレクトリ |
| `namespace` | title の PascalCase | ルート namespace（ランタイムは `<namespace>.Core`） |
| `clientName` | `'ApiClient'` | クライアントクラス名（オプションクラスは `<clientName>Options`） |
| `package` | info から導出 | `.csproj` の `name`（= PackageId / AssemblyName）/ `version` / `description` / `authors` / `license`。`false` で生成しない |
| `naming` | 型・プロパティ PascalCase、メソッド `{{name}}Async` | `{ type, method, property, file }` ごとに `{ case, name }` |
| `typeMappings` | `{}` | `'string:uuid': 'string'` / `'integer': 'long'` のような `kind:format` または `kind` → C# 型式の上書き |
| `hooks` | `{}` | `typeName` / `methodName`（基底名を返し、`naming.method` のテンプレートはその後に適用）/ `propertyName` / `fileName` / `typeOverride` |
| `include` / `exclude` | なし | プラグイン単位の操作フィルタ |

Kotlin プラグイン（`kotlin()`）の主なオプション（すべて任意）:

| オプション | 既定 | 内容 |
|---|---|---|
| `output` | `'kotlin'` | 出力サブディレクトリ |
| `packageName` | title を `.` で区切り、各部分を英数字の小文字にしたもの | ルート package（ランタイムは `<packageName>.core`、モデルは `.models`、サービスは `.services`） |
| `clientName` | `'ApiClient'` | クライアントクラス名（オプションクラスは `<clientName>Options`） |
| `package` | info から導出 | Gradle の `group`（既定 packageName）/ `name`（既定 title の kebab-case）/ `version` / `description` / 追加の `dependencies`（`implementation(...)`）。`false` で Gradle ファイルを生成しない |
| `naming` | 型 PascalCase、メソッド・プロパティ camelCase | `{ type, method, property, file }` ごとに `{ case, name }` |
| `typeMappings` | `{}` | `'integer': 'Long'` や `'string:date-time': { type: 'kotlinx.datetime.Instant', serializer: 'kotlinx.datetime.serializers.InstantIso8601Serializer' }` のような `kind:format` / `kind` → Kotlin 型（文字列なら serializer は `<type>.serializer()`） |
| `hooks` | `{}` | `typeName` / `methodName` / `propertyName` / `fileName` / `typeOverride`（Kotlin 型、または `{ type, serializer }`） |
| `include` / `exclude` | なし | プラグイン単位の操作フィルタ |

Rust プラグイン（`rust()`）の主なオプション（すべて任意）:

| オプション | 既定 | 内容 |
|---|---|---|
| `output` | `'rust'` | 出力サブディレクトリ |
| `clientName` | `'ApiClient'` | クライアント構造体名（ビルダーは `<clientName>Builder`） |
| `package` | info から導出 | `Cargo.toml` の `name`（既定 title の kebab-case）/ `version`（既定 `info.version`、semver でなければ `0.1.0`）/ `description` / `license` / `authors` / `repository` / 追加の `dependencies`（`[dependencies]` にそのまま書く行）。`false` で `Cargo.toml` を生成しない |
| `naming` | 型 PascalCase、メソッド・フィールド snake_case、ファイルは型名の snake_case | `{ type, method, property, file }` ごとに `{ case, name }` |
| `typeMappings` | `{}` | `'integer': 'i32'` や `'string:date-time': 'chrono::DateTime<chrono::Utc>'` のような `kind:format` / `kind` → Rust 型（serde を実装していること） |
| `hooks` | `{}` | `typeName` / `methodName` / `propertyName` / `fileName` / `typeOverride`（Rust 型） |
| `include` / `exclude` | なし | プラグイン単位の操作フィルタ |

## 生成された SDK の使い方

`ts/` の下に `types.gen.ts` / `sdk.gen.ts` / `client.gen.ts` / `index.ts` / `core/`（ランタイム）が出力されます。
操作は `method` + パスの camelCase 名の関数になります（例: `GET /catalyst/v1/status/{id}` → `getCatalystV1StatusById`）。
パスパラメータ・クエリ・ボディはそれぞれ `path` / `query` / `body` で渡します。

```ts
import { createApiClient, getCatalystV1Announcements, getCatalystV1StatusById } from './sdk/ts/index.js';

// baseUrl の既定は spec の servers[0]（servers が無ければ '/'）
const client = createApiClient({
  auth: { bearerAuth: 'my-token' }, // または () => getToken()
  headers: { 'X-App': 'demo' },
  timeout: 10_000, // ミリ秒
});

const { data, error, response } = await getCatalystV1StatusById({ client, path: { id: '123' } });
if (error) {
  console.error(error.status, error.body); // ApiError。body は該当ステータスの型付きエラーボディ
} else {
  console.log(data.status);
}

// throwOnError: 失敗時に例外を投げ、戻り値は { data, response } になる（client 設定でも指定可）
const { data: list } = await getCatalystV1Announcements({ client, throwOnError: true });
```

`client` を省略すると生成済みの共有クライアント（`client.gen.ts` の `client`）が使われます。各呼び出しには
`signal`（`AbortSignal`）、`baseUrl`、`extensions`（middleware に渡す任意値）も指定できます。

`baseUrl` が相対（spec の servers が `/api` のような相対 URL、または servers が無く既定の `/`）の場合、ブラウザでは
`location.href` に対して解決します。`location` の無い環境（Node.js / Workers など）では `TypeError` になるので、
`createApiClient({ baseUrl: 'https://api.example.com' })` のように絶対 URL を渡してください。

パスパラメータの値が `''` / `.` / `..` になる（そのセグメントが空や dot segment になる）呼び出しは、URL の正規化で
別のパスに送られるのを防ぐため送信前に `TypeError` になります。`allowReserved` はクエリパラメータにだけ適用されます。

### 認証

`auth` のキーは spec の securitySchemes 名で、型は spec から生成されます。値は文字列または（非同期）関数です。

```ts
createApiClient({
  auth: {
    bearerAuth: 'token', // http bearer
    basicAuth: { username: 'u', password: 'p' }, // http basic
    apiKeyHeader: () => loadKey(), // apiKey（in / name は spec に従う: header / query / cookie）
    oauth2: {
      accessToken: 'token', // 固定トークン
      // または
      clientCredentials: { clientId: 'id', clientSecret: 'secret', scopes: ['read'], tokenUrl: '/oauth/token' },
      // または
      refreshToken: { refreshToken: 'rt', clientId: 'id', onRefreshed: (tokens) => save(tokens) },
    },
  },
});
```

- 操作の `security`（OR-of-AND）を先頭から評価し、設定済みスキームで満たせる最初の代替を適用します。`{}`（任意認証）を含む操作は未設定なら認証なしで送信し、必須認証が満たせない場合は送信前に `AuthError` を投げます。
- 認証は middleware チェーンの最内側（transport 直前）で適用されます。
- OAuth2 トークンは期限の 30 秒前に先回りで更新され、同時更新は 1 回にまとめられ、401 を受けたら 1 回だけ強制更新して再送します。相対の `tokenUrl` / `refreshUrl` は（相対なら上記のとおり解決した）`baseUrl` に対して解決され、絶対 URL はそのまま使われます。解決できなければ `AuthError` です。
- `http` の bearer / basic 以外（digest など）や `mutualTLS` は生成時に警告となり、`createApiClient({ customAuth: (req, ctx) => { ... } })` で対応します。`customAuth` を設定すると、これらのスキームは「設定済み」とみなされ（適用は `customAuth` の責任）、未設定なら `AuthError` になります。
- 操作の `security` が `components.securitySchemes` に無いスキーム名を参照していると、生成時に `unknown-security-scheme` の警告が出ます。

### Middleware

onion 型です。登録順に外側から実行され、`createApiClient({ middleware: [...] })` または `client.use(mw)` で登録します。

```ts
import { createApiClient, loggingMiddleware, retry401Middleware, retryMiddleware, userAgentMiddleware } from './sdk/ts/index.js';
import type { Middleware } from './sdk/ts/index.js';

const timing: Middleware = async (req, next, ctx) => {
  const started = Date.now();
  const res = await next(req);
  console.log(ctx.operationName, res.status, Date.now() - started);
  return res;
};

const client = createApiClient({
  middleware: [
    loggingMiddleware(), // Authorization / Cookie / Proxy-Authorization と apiKey のヘッダ・クエリをマスク
    userAgentMiddleware('my-app/1.0'),
    retryMiddleware({ maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 }), // 冪等メソッドのみ。429/503 は Retry-After を尊重
    retry401Middleware({ onUnauthorized: async () => refreshStaticToken() }), // true を返すと 1 回だけ再送
    timing,
  ],
});
```

標準 middleware は `loggingMiddleware` / `userAgentMiddleware` / `retryMiddleware` / `retry401Middleware` の 4 つです。
`CallContext`（`ctx`）は `operationName` / `method` / `pathTemplate` / `tags` / `security` / `attempt` / `signal` / `extensions` を持ちます。
body がストリームでリプレイ不可（`req.replayable === false`）のときは、retry 系は再送しません。

### 結果とエラー

非 2xx 応答だけが `ApiError` として `{ data: undefined, error, response }` の `error` に入って返ります（`throwOnError: true` ならこれも例外になります）。
それ以外の `TransportError` / `AuthError` / デシリアライズ失敗（2xx 本文の `DecodeError`）は `throwOnError` に関係なく常に例外です。

| クラス | 内容 |
|---|---|
| `ApiError` | 非 2xx（`throwOnError` 時のみ throw、既定は `error` で返る）。`status` / `body`（型付きエラーボディ）/ `response` |
| `TransportError`（常に throw） | 通信失敗・タイムアウト・キャンセル。`timedOut` / `cause` |
| `DecodeError`（2xx 本文では常に throw） | 応答のデシリアライズ失敗。`raw`（生 body）/ `response` |
| `AuthError`（常に throw） | 必須認証が未設定。`schemes` |

### 対応ランタイム

Browser / Node.js 18+ / Bun / Deno / React Native / Cloudflare Workers（ESM のみ）。グローバルの `fetch` / `Request` / `Response` /
`Headers` / `URL` / `FormData` / `Blob` / `AbortController` だけを使います。`createApiClient({ fetch })` で `fetch` を差し替えられます。
利用側の tsconfig は `strict: true`, `target: ES2022`, `lib: ["ES2022", "DOM"]`, `module: "NodeNext"` を想定しています。

### 既知の制約

- 認証情報を持つリクエストのリダイレクトで資格情報を外す処理（§8.5）は、ブラウザ / React Native ではベストエフォートです（リダイレクトをプラットフォームが追従するため）。
- `timeout` はレスポンスヘッダの到着までを対象にします。ヘッダ受信後に中断しても本文の読み込みはキャンセルされません。
- TypeScript の判別可能 union で絞り込むには、spec 側で判別プロパティがリテラル（`const` / 単一値の `enum`）になっている必要があります。
- middleware / オプション名は spec §6.2 の表記と異なります（`loggingMiddleware`、`retryMiddleware` の `baseDelayMs` など）。

## 生成された C# SDK の使い方

.NET 10（`net10.0`）向けで、依存は BCL のみです。JSON は System.Text.Json の source generation を使うので AOT / トリミングに対応します。

```
csharp/
  Natsuneko.Api.csproj        # package: false なら出力しない
  ApiClient.cs                # ApiClient / ApiClientOptions
  ApiAuth.cs                  # スキーム名ごとの型付き認証設定
  ApiJsonContext.cs           # JsonSerializerContext（[JsonSerializable] の一覧）
  Models/*.cs                 # schema ごとに 1 ファイル（inline の object / enum / union は {Parent}{Prop} で巻き上げ）
  Services/<Group>Service.cs  # タグ（group）ごとのサービス
  Core/*.cs                   # ランタイム（runtimes/csharp/src のコピー）
```

```csharp
using Natsuneko.Api;
using Natsuneko.Api.Core;

var client = new ApiClient(new ApiClientOptions
{
    BaseUrl = "https://api.natsuneko.com",          // 既定は servers[0]（ApiClient.DefaultBaseUrl）
    Auth = new ApiAuth { BearerAuth = "token" },    // 文字列、または new TokenValue(ct => ...)
    Timeout = TimeSpan.FromSeconds(30),
    Middleware = { new RetryMiddleware(), new UserAgentMiddleware("my-app/1.0") },
});

var status = await client.Catalyst.GetCatalystV1StatusByIdAsync("123");            // 成功ボディを返す
var result = await client.Catalyst.GetCatalystV1StatusByIdWithResponseAsync("123"); // StatusCode / Headers / Url / Data
```

- 引数は path → 必須 body → 必須 query / header / cookie → 任意（`= null`）→ `RequestOptions? requestOptions` → `CancellationToken`。名前付き引数で任意パラメータを指定できます。
- 非 2xx は常に例外です: `ApiException<T>`（そのステータスで宣言された型の `Body`。`404` → `4XX` → `default` の順に探す）、宣言が無い / ボディが壊れている場合は `ApiException`（`StatusCode` / `Headers` / `RawBody` / `Url`）。通信失敗・タイムアウトは `ApiTransportException`（`TimedOut`）、2xx ボディのデコード失敗は `ApiDecodeException`（`RawBody`）、必須認証の未設定は送信前に `ApiAuthException`（`Schemes`）。呼び出し側のキャンセルは `OperationCanceledException` です。
- 認証は `ApiAuth` のプロパティ（スキーム名の PascalCase）に設定します: bearer / apiKey は `TokenValue`、basic は `BasicValue`、OAuth2 / OpenID Connect は `OAuth2Value { AccessToken | ClientCredentials | RefreshToken }`。OAuth2 のトークンは期限 30 秒前に先回り更新、同時取得は 1 回にまとめ、管理トークンで 401 を受けたら 1 回だけ更新して再送します。未対応スキーム（digest、mutualTLS）は `ClientOptions.CustomAuth` で扱います。
- Middleware は `IApiMiddleware`（`InvokeAsync(request, next, context, cancellationToken)`）か `ApiMiddleware.Create((req, next, ctx, ct) => ...)` で作り、`Middleware` に登録するか `client.Use(...)` で追加します。登録順に外側から実行され、認証は最内側で適用されます。標準: `LoggingMiddleware`（資格情報をマスク）/ `UserAgentMiddleware` / `RetryMiddleware` / `Retry401Middleware`。
- 独自の `HttpClient`（`ClientOptions.HttpClient`）は、ハンドラを `AllowAutoRedirect = false` / `UseCookies = false` にしてください。リダイレクトはランタイムが手動で追い、別オリジンへ移るときは `Authorization` / `Cookie` / API キーを外します。

型の対応: `date-time` → `DateTimeOffset`、`date` → `DateOnly`、`uuid` → `Guid`、`int64` → `long`（format 無しの integer は `int`）、`binary` → `ApiFile`（`byte[]` または `Stream` + ファイル名）、未知の schema → `JsonElement`、必須プロパティは `required`、任意 / nullable は `T?`。

- **enum** は未知の値を保持する構造体です（`Status.Active`、`status.Value`、`status.IsKnown`）。`switch` は `status.Value` か `==` で比較します。
- **判別あり union** は `[JsonPolymorphic]` 基底クラス + 派生クラスです（`shape is Circle c`）。未知の判別値は基底型そのもののインスタンスになり、他のプロパティは `AdditionalProperties` に入ります（判別値そのものは System.Text.Json の制約で保持されません）。バリアント型（`Circle`）を宣言したリクエストボディは基底型経由で直列化するので判別プロパティも送られますが、モデルのプロパティがバリアント型で宣言されている場合は判別プロパティが出力されません。バリアントが複数の union に属するなど基底クラスにできない場合と、**判別なし union** は、`Value` / バリアントごとのアクセサ（`pet.Cat`）/ `Unknown`（生 JSON）を持つラッパークラスになり、バリアントを宣言順に試して最初に読めたものを採用します。
- 任意プロパティの `null` は送信しません（「未設定」と「null」の区別はスコープ外）。空の JSON 応答（204 など）は `null`（`default`）を返します。

## 生成された Kotlin SDK の使い方

JVM 11+ / Android 向けで、依存は `io.ktor:ktor-client-core` と `org.jetbrains.kotlinx:kotlinx-serialization-json`（どちらも `api`）のみです。
HTTP engine は利用者が選びます（JVM なら CIO / OkHttp、Android なら OkHttp / Android）。serializer は型ごとに明示しており、
リフレクションによる探索を使わないので R8 / ProGuard でもそのまま動きます。

```
kotlin/
  build.gradle.kts, settings.gradle.kts   # package: false なら出力しない（Gradle wrapper は含めない）
  src/main/kotlin/com/natsuneko/api/
    ApiClient.kt                          # ApiClient / ApiClientOptions
    ApiAuth.kt                            # スキーム名ごとの型付き認証設定
    models/*.kt                           # schema ごとに 1 ファイル
    services/<Group>Service.kt            # タグ（group）ごとのサービス（suspend 関数）
    core/*.kt                             # ランタイム（runtimes/kotlin のコピー、package は <packageName>.core）
```

```kotlin
import com.natsuneko.api.ApiAuth
import com.natsuneko.api.ApiClient
import com.natsuneko.api.core.RetryMiddleware
import com.natsuneko.api.core.TokenValue
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlin.time.Duration.Companion.seconds

val client = ApiClient {
    baseUrl = "https://api.natsuneko.com"           // 既定は servers[0]（ApiClient.DEFAULT_BASE_URL）
    httpClient = HttpClient(CIO)                     // 省略すると classpath 上の engine で作る
    auth = ApiAuth(bearerAuth = TokenValue("token")) // または TokenValue { fetchToken() }（送信のたびに呼ばれる）
    timeout = 30.seconds
    middleware.add(RetryMiddleware())
}

val status = client.catalyst.getCatalystV1StatusById("123")              // 成功ボディを返す
val result = client.catalyst.getCatalystV1StatusByIdWithResponse("123")  // statusCode / headers / url / data
client.close()  // SDK が作った HttpClient だけを閉じる
```

- 引数は path → 必須 body → 必須 query / header / cookie → 任意（`= null`）→ `requestOptions: RequestOptions? = null`。名前付き引数で任意パラメータを指定できます。no-content の操作は `Unit` を返します。
- 非 2xx は常に `ApiException`（`statusCode` / `headers` / `rawBody` / `url`）です。宣言された型のボディは `error.bodyAs<NotFoundError>()` で取り出します（Kotlin の例外は型パラメータを持てないため、C# と違い非ジェネリック）。通信失敗・タイムアウトは `ApiTransportException`（`timedOut`）、2xx ボディのデコード失敗は `ApiDecodeException`（`rawBody`）、必須認証の未設定は送信前に `ApiAuthException`（`schemes`）。コルーチンのキャンセルは `CancellationException` のまま伝わります。
- 認証は `ApiAuth` のプロパティ（スキーム名の camelCase）に設定します: bearer / apiKey は `TokenValue`、basic は `BasicValue`、OAuth2 / OpenID Connect は `OAuth2Value(accessToken | clientCredentials | refreshToken)`。OAuth2 のトークンは期限 30 秒前に先回り更新、同時取得は 1 回にまとめ（1 つの呼び出しをキャンセルしても他は巻き込まない）、管理トークンで 401 を受けたら 1 回だけ更新して再送します。未対応スキームは `customAuth` で扱います。
- Middleware は `Middleware { request, next, context -> next(request) }`（`fun interface`）で作り、`middleware` に登録するか `client.use(...)` で追加します。登録順に外側から実行され、認証は最内側で適用されます。標準: `LoggingMiddleware`（資格情報をマスク）/ `UserAgentMiddleware` / `RetryMiddleware` / `Retry401Middleware`。
- 渡した `HttpClient` は `config { followRedirects = false; expectSuccess = false }` の派生クライアントで使うので、自動リダイレクトや `expectSuccess` を設定済みでも構いません。リダイレクトはランタイムが手動で追い、別オリジンへ移るときは `Authorization` / `Cookie` / API キーを外します。`client.close()` は渡した `HttpClient` を閉じません。

型の対応: `date-time` / `date` / `uuid` / `uri` / `byte` → `String`（`typeMappings` で差し替え可）、`int64` → `Long`（format 無しの integer は `Int`）、`binary` → `ApiFile`（`ByteArray` + ファイル名 + Content-Type）、未知の schema → `JsonElement`、任意プロパティは `T? = null`、必須 + nullable は `T?`（既定値なし）。

- **enum** は未知の値を保持するクラスです（`Status.Active`、`status.value`、`status.isKnown`、`Status.knownValues`）。`enum class` では未知の値を再送できないためで、`when (status) { Status.Active -> … else -> … }` のように `else` が必要です（前方互換のため）。
- **union** は `sealed interface` です。名前付き object のバリアントはそのデータクラス自身が実装し（`data class Cat(…) : Pet`、1 つのクラスが複数の union を実装できる）、それ以外は入れ子のラッパー（`Pet.StringValue(value)`、`Pet.CatList(value)`）になります。**判別あり** は判別値でバリアントを選び、**判別なし** はバリアントを宣言順に試して最初に読めたものを採用します。どれにも当たらなければ `Pet.Unknown(raw)` に生 JSON をそのまま（未知の判別値も含めて）保持します。判別プロパティはバリアントに残り、既定値（タグ）を持つので書かなくても送られます（`Circle(radius = 1.0)`）。
- 任意プロパティの `null` は送信しません。宣言型が non-null の成功応答が空（204 など）のときは `null` ではなく `ApiDecodeException` になります（schema が nullable なら `null`）。
- additionalProperties とプロパティを両方持つ object の追加プロパティは保持しません（プロパティの無い object は `Map<String, T>`）。

生成した SDK は利用者の Gradle でビルドします。このリポジトリでは `runtimes/kotlin/gradlew -p <出力先> build` で試せます。

## 生成された Swift SDK の使い方

Swift 6（tools-version 6.0、Swift 6 言語モード）向けの SwiftPM パッケージで、依存は Foundation のみです（Linux では `FoundationNetworking`）。
macOS 12 / iOS 15 / tvOS 15 / watchOS 8 / visionOS 1 以降と Linux で動きます。公開型はすべて `Sendable` です。

```
swift/
  Package.swift                          # package: false なら出力しない
  Sources/<Module>/ApiClient.swift        # ApiClient
  Sources/<Module>/ApiAuth.swift          # スキーム名ごとの型付き認証設定
  Sources/<Module>/Exports.swift          # @_exported import <Module>Core（ランタイムの型も import <Module> で使える）
  Sources/<Module>/Models/*.swift         # schema ごとに 1 ファイル（inline の object / enum / union は {Parent}{Prop} で巻き上げ）
  Sources/<Module>/Services/<Group>Service.swift
  Sources/<Module>Core/*.swift            # ランタイム（runtimes/swift/src のコピー）。別ターゲットなのでモデル名と衝突しない
```

モジュール名は既定で `info.title` の PascalCase です（`swift({ moduleName: 'NatsunekoApi' })` で変更）。生成先をパスで依存に加えます。

```swift
// Package.swift
.package(path: "sdk/swift"),
// ターゲットの dependencies
.product(name: "NatsunekoApi", package: "swift"),
```

```swift
import NatsunekoApi

let client = ApiClient(
    baseUrl: "https://api.natsuneko.com",   // 既定は servers[0]（ApiClient.defaultBaseUrl）
    auth: ApiAuth(bearerAuth: "token"),     // 文字列、または TokenValue(provider: { ... })
    timeout: 30,
    middleware: [RetryMiddleware(), UserAgentMiddleware("my-app/1.0")]
)

let status = try await client.catalyst.getCatalystV1StatusById(id: "123")             // 成功ボディを返す
let result = try await client.catalyst.getCatalystV1StatusByIdWithResponse(id: "123")  // statusCode / headers / url / data
```

- 引数ラベルはパラメータ名の camelCase で、順序は path → 必須 `body:` → 必須 query / header / cookie → 任意（`= nil`）→ `options: RequestOptions?`。
- 非 2xx は `ApiError` を throw します（`statusCode` / `headers` / `url` / `rawBody`）。そのステータスで宣言された型のボディは `error.body(as: NotFoundError.self)` で取り出します（`404` → `4XX` → `default` の順に探し、デコードできなければ `nil`）。通信失敗・タイムアウトは `TransportError`（`timedOut`）、2xx ボディのデコード失敗は `DecodeError`（`rawBody`）、必須認証の未設定は送信前に `AuthError`（`schemes`）、パスパラメータの欠落などは `ArgumentError`。呼び出し側の Task キャンセルは `CancellationError` です。
- 認証は `ApiAuth` のプロパティ（スキーム名の camelCase）に設定します: bearer / apiKey は `TokenValue`、basic は `BasicValue`、OAuth2 / OpenID Connect は `OAuth2Value(accessToken:clientCredentials:refreshToken:)`。トークンの先回り更新・single-flight（actor）・401 での 1 回の再送は TypeScript / C# と同じです。未対応スキームは `customAuth: { request, context in ... }` で扱います。
- Middleware は `Middleware` プロトコル（`intercept(_:context:next:)`）か `ClosureMiddleware { request, context, next in ... }` で作り、`middleware:` に渡すか `client.use(...)` で追加します。標準: `LoggingMiddleware`（資格情報をマスク）/ `UserAgentMiddleware` / `RetryMiddleware(RetryOptions)` / `Retry401Middleware`。
- 送信は `HTTPTransport`（既定は Cookie・キャッシュ無効で自動リダイレクトしない `URLSessionTransport`）です。独自の `URLSession` を使うときは `URLSessionTransport(session:)` に、リダイレクトを追わない（`willPerformHTTPRedirection` で `nil` を返す）デリゲートを持つセッションを渡してください。リダイレクトはランタイムが手動で追い、別オリジンへ移るときは `Authorization` / `Cookie` / API キーを外します。

型の対応: `date-time` → `Date`（RFC 3339、小数秒とオフセット対応）、`date` → `CalendarDate`（ランタイムの年月日型）、`uuid` → `UUID`、`int64` → `Int64`（`int32` は `Int32`、format 無しは `Int`）、`byte` → `Data`、`binary` → `ApiFile`（`Data` + ファイル名 + Content-Type。リクエスト / レスポンスの binary body は `Data`）、未知の schema → `JSONValue`、任意 / nullable は `T?`。モデルは `Codable, Hashable, Sendable` の struct で、全プロパティを引数に取るイニシャライザを持ちます。

- **enum** は既知値の case と `unknown(String)`（数値 enum は `unknown(Int)` / `unknown(Double)`）を持ち、`rawValue` / `isKnown` / `allCases` を提供します。整数値の case は `_1` のようになります。
- **union** は関連値付きの `indirect enum` です（`case .circle(let c)`）。判別ありは判別値で、判別なしは宣言順に試して最初に読めたバリアントになり、どれにも当てはまらなければ `unknown(JSONValue)` で生 JSON を保持します。判別プロパティはバリアントの struct に残り、`const` / 単一値 enum ならイニシャライザの既定値になります（`Circle(radius: 1)`）。
- 値型が自分自身を値で含む循環（`Node.parent: Node?`、`A.b` ↔ `B.a`）は、該当プロパティをランタイムの `Indirect` に格納します（公開されるのは通常のプロパティです）。
- 他言語との意図的な差分: Foundation の `URL` が受け付けない `|` `[` `]` は path / query で常に percent-encode します（`piped=1%7C2`、`filter%5Bstatus%5D=active`。サーバーでデコードした値は同じ）。空の JSON 応答（204 など）は戻り値型が Optional なら `nil`、そうでなければ `DecodeError` です。JSON の直列化はキー順を宣言順に保つためランタイムの `JSONValueEncoder` / `ApiJSON` を使い（`JSONEncoder` はキー順を保持しません）、デコードは `JSONDecoder` です。

## 生成された Rust SDK の使い方

stable Rust（edition 2021、1.88 以降。依存の `url` / `icu_*` が 1.88 を要求するため）向けで、依存は `reqwest`（`default-features = false`）/ `serde` / `serde_json`（`preserve_order`）/
`tokio`（`time` / `sync` のみ）です。TLS は feature で選びます（既定 `rustls`、`--no-default-features --features native-tls` で native-tls）。
非同期ランタイムは tokio を前提にしますが、SDK 自身はタスクを spawn しません。

```
rust/
  Cargo.toml                  # package: false なら出力しない
  src/
    lib.rs                    # pub use ApiClient / ApiClientBuilder / ApiAuth
    client.rs  auth.rs        # クライアントとビルダー、スキーム名ごとの型付き認証設定
    models/*.rs               # schema ごとに 1 ファイル（models::Pet のように再エクスポート）
    services/<group>.rs       # タグ（group）ごとのサービス、操作ごとのリクエストビルダーとエラー enum
    core/*.rs                 # ランタイム（runtimes/rust/src のコピー）
```

```rust
use std::time::Duration;

use natsuneko_laboratory_api::core::{RetryMiddleware, TokenValue};
use natsuneko_laboratory_api::{ApiAuth, ApiClient};

let client = ApiClient::builder()
    .base_url("https://api.natsuneko.com")                                // 既定は servers[0]（ApiClient::DEFAULT_BASE_URL）
    .auth(ApiAuth { bearer_auth: Some("token".into()), ..Default::default() }) // または TokenValue::provider(|| async { fetch_token().await })
    .timeout(Duration::from_secs(30))
    .middleware(RetryMiddleware::new())
    .build();

let status = client.catalyst().get_catalyst_v1_status_by_id("123").await?;      // ApiResponse<T>: status / headers / url / data
let posts = client.catalyst().get_catalyst_v11_timeline_album_by_id("album").limit(20).send().await?; // 任意パラメータは setter
```

- 必須パラメータ（path → 必須 body → 必須 query / header / cookie）はメソッドの引数（`impl Into<T>`）、任意パラメータはビルダーの同名 setter です。ビルダーは `.await`（`IntoFuture`）か `.send().await` で送ります。`.request_options(RequestOptions::new().header(…))` で呼び出しごとのヘッダ・extensions・base URL を指定できます。`ApiClient` の clone は安価で、clone 同士はコネクションプール・middleware・トークンを共有します。
- 結果は `Result<ApiResponse<T>, core::Error<E>>` です。非 2xx は `Error::Api`（`status` / `headers` / `url` / `raw_body` / `body`）で、`body` には操作ごとのエラー enum（`GetErrorError::Status404(NotFoundError)`、範囲は `Status4xx`、`default` は `Default`）に宣言どおりデコードできたときだけ値が入ります。宣言の無い操作の `E` は `()` です。通信失敗・タイムアウトは `Error::Transport`（`timed_out`）、2xx ボディのデコード失敗は `Error::Decode`（`raw_body`）、必須認証の未設定は送信前に `Error::Auth`（`schemes`）、組み立てられないリクエスト（必須 path の欠落、CR / LF を含むヘッダ、相対 base URL）は `Error::InvalidRequest` です。キャンセルは future の drop です。
- 認証は `ApiAuth` のフィールド（スキーム名の snake_case）に設定します: bearer / apiKey は `TokenValue`、basic は `BasicValue`、OAuth2 / OpenID Connect は `OAuth2Value`（`access_token` / `client_credentials` / `refresh_token`）。トークンは期限 30 秒前に先回り更新、同時取得は 1 回にまとめ、管理トークンで 401 を受けたら 1 回だけ更新して再送します。未対応スキームは `custom_auth` で扱います。
- Middleware は `core::Middleware` トレイトを実装するか、`middleware_fn(|req, ctx, next| Box::pin(async move { next.run(req).await }))` で作り、ビルダーの `middleware(...)` か `client.use_middleware(...)` で登録します。登録順に外側から実行され、認証は最内側で適用されます（`next` は `Copy` なので何度でも呼べます）。標準: `LoggingMiddleware`（資格情報をマスク）/ `UserAgentMiddleware` / `RetryMiddleware` / `Retry401Middleware`。
- `reqwest::Client` は後から設定を変えられないため、渡す場合は `core::http_client_builder()`（リダイレクト無効）から作ってください。リダイレクトはランタイムが手動で追い、別オリジンへ移るときは `Authorization` / `Cookie` / API キー（ヘッダ・クエリ）を外します。リダイレクトを追う Client を渡すと reqwest 自身の挙動（`Authorization` / `Cookie` は外すが API キーは残る）になります。

型の対応: `date-time` / `date` / `uuid` / `uri` / `byte` → `String`（`typeMappings` と `package.dependencies` で `chrono` / `uuid` に差し替え可）、`int64` と format 無しの integer → `i64`（`int32` → `i32`）、`float` → `f32`、その他の number → `f64`、`binary` → `ApiFile`（`Vec<u8>` + ファイル名 + Content-Type）、未知の schema → `serde_json::Value`、additionalProperties → `HashMap<String, T>`、任意 / nullable → `Option<T>`。予約語は `r#type` のような raw identifier（`self` などは `self_`）、`Vec<T>` を挟まずに自分を含む型は `Box<T>` で持ちます。

- **enum** は `Unknown(…)` バリアントを持つ enum です（`Status::Active`、`status.as_str()` / `priority.value()`、`is_known()`、`KNOWN_VALUES`、`From<&str>`）。未知の値も再送できます。比較は値で行います。
- **判別あり union** は判別値でバリアントを選ぶ enum（`Shape::Circle(Circle)`）、**判別なし union** は `#[serde(untagged)]` の enum で、バリアントを宣言順に試して最初に読めたものを採用します。どれにも当たらなければ `Unknown(serde_json::Value)` に生 JSON をそのまま保持し、そのまま書き戻せます。判別プロパティはバリアントの構造体に残ります（`Circle { kind: "circle".into(), .. }`）。
- 任意プロパティの `None` は送信しません。宣言型が `Option` でない成功応答が空（204 など）のときは `Error::Decode` になります。
- multipart は reqwest の `multipart` ではなくランタイムが組み立てるので、リトライ・リダイレクト・401 再送でも同じ body を送り直せます。

生成した SDK は Cargo の path / git 依存として取り込めます（`cargo check` で確認できます）。

## カスタムプラグイン

`definePlugin` で作ります。依存プラグイン（ここでは `typescript`）の公開 API `symbols` から、生成済みの型名・関数名を参照できます。

```ts
import { defineConfig, definePlugin } from '@natsuneko-laboratory/archon';
import { typescript } from '@natsuneko-laboratory/archon/plugins';
import type { TypeScriptPluginAPI } from '@natsuneko-laboratory/archon/plugins';

const operationList = definePlugin<{ output: string }>({
  name: 'operation-list',
  dependencies: ['typescript'], // 先に実行される
  factories: { typescript }, // 設定に無ければ既定設定で自動追加する
  defaults: { output: 'operation-list' },
  generate(ctx) {
    const ts = ctx.plugin<TypeScriptPluginAPI>('typescript');
    const lines = ctx.ir.operations.map((op) => `${op.id} -> ${ts.symbols.operation(op.id).functionName}`);
    ctx.emit('operations.txt', `${lines.join('\n')}\n`); // output からの相対パス
  },
});

export default defineConfig({
  input: './openapi.yaml',
  output: './sdk',
  plugins: [typescript(), operationList()],
});
```

`PluginDefinition` には他に `transformIR(ir, ctx)`（全プラグインの `generate` より前に IR を加工）と `irRequirements`（inline object / enum の巻き上げ指定）があります。
`ctx` は `ir` / `options` / `config` / `diagnostics` / `emit` / `writer()`（`CodeWriter`）/ `headerLines(language)` / `plugin(name)` を提供します。

## ロードマップ

各マイルストーンは「生成 → コンパイル → E2E 通過」で完了とします。

| | 内容 | 状態 |
|---|---|---|
| M1 | コア（loader / parser / IR / passes / 設定 / プラグイン API / CLI / CodeWriter）+ TypeScript プラグイン & ランタイム + モックサーバ + E2E 基盤 | 実装済み |
| M2 | C#（.NET 10）プラグイン & BCL のみのランタイム | 実装済み |
| M3 | Kotlin（JVM 11+ / Android）プラグイン & ktor-client-core + kotlinx-serialization-json のみのランタイム | 実装済み |
| M4 | Swift 6 プラグイン & Foundation のみのランタイム（Apple プラットフォーム / Linux） | 実装済み |
| M5 | Rust（stable、edition 2021）プラグイン & reqwest + serde + serde_json + tokio のみのランタイム | 実装済み |
| M6 | Go 1.22+ | 未着手 |
| M7 | Ruby 3.2+ | 未着手 |

M1 の TypeScript プラグインでは `bigint`（int64）オプション、`naming.property` / `hooks.propertyName` / `naming.file` / `hooks.fileName` は提供していません。

## 開発

```sh
pnpm test        # 単体・スナップショット・生成物のコンパイルテスト（vitest）
pnpm typecheck   # 全パッケージの tsc --noEmit
pnpm test:e2e    # モックサーバに対して生成 SDK を実行する E2E（e2e/typescript）
pnpm test:e2e:csharp   # 同じシナリオを生成 C# SDK で実行する E2E（e2e/csharp、要 .NET 10 SDK）
dotnet test runtimes/csharp/tests/Archon.Runtime.Tests   # C# ランタイムの単体テスト
pnpm test:e2e:kotlin   # 同じシナリオを生成 Kotlin SDK で実行する E2E（e2e/kotlin、要 JDK 17+）
runtimes/kotlin/gradlew -p runtimes/kotlin test   # Kotlin ランタイムの単体テスト（Gradle wrapper 同梱）
pnpm test:e2e:swift    # 同じシナリオを生成 Swift SDK で実行する E2E（e2e/swift、要 Swift 6.1+）
swift test --package-path runtimes/swift                 # Swift ランタイムの単体テスト（swift-testing）
pnpm test:e2e:rust     # 同じシナリオを生成 Rust SDK で実行する E2E（e2e/rust、要 cargo）
cargo test --manifest-path runtimes/rust/Cargo.toml   # Rust ランタイムの単体テスト
pnpm build       # 全パッケージのビルド
pnpm -F @natsuneko-laboratory/archon-e2e-typescript smoke bun   # 生成 SDK を Bun / Deno（`smoke deno`）でモックサーバに対して実行
```

CI（`.github/workflows/ci.yml`）は上記に加え、ランタイムの単体テストを Node.js 18 / 20 / 22 / 24 で、生成 SDK のスモークを Bun / Deno で実行します。

C# 生成物のコンパイルテスト（`dotnet build -warnaserror`）は .NET 10 以降の SDK が無ければスキップされます（CI では `actions/setup-dotnet` で入れて実行します）。
Kotlin 生成物のコンパイルテスト（`gradle build`、警告をエラー扱い）は JDK 17 以降が無ければスキップされます（CI では `actions/setup-java` で入れて実行します）。
Swift 生成物のコンパイルテスト（`swift build -Xswiftc -warnings-as-errors`）は Swift 6 以降が無ければスキップされます。Swift のランタイム単体テストと E2E は、CI で Linux（`swift:6.2` コンテナ）と macOS の両方で実行します。
Rust 生成物のコンパイルテスト（`cargo clippy -- -D warnings`）は `cargo` が無ければスキップされます（CI では `dtolnay/rust-toolchain` で入れて実行します）。

### ライブスモーク（手動）

`api.natsuneko.com` に対し、認証不要または任意認証（`{}` を含む）で必須パラメータ無しの GET を最大 3 件、生成 SDK で実際に呼びます（要ネットワーク）。
`examples/natsuneko/archon.config.ts` で一時ディレクトリに SDK を生成し、HTTP 200 と `data` が `undefined` でないことを確認して、1 件でも失敗すれば非ゼロで終了します。

```sh
node --experimental-strip-types scripts/live-smoke.ts
```

GitHub Actions の `Live smoke` ワークフロー（`workflow_dispatch` のみ）からも実行できます。

`security: []` の操作を優先し、足りなければ任意認証の操作で埋めます。spec の宣言と実 API の挙動が食い違う操作は `scripts/live-smoke.ts` の `KNOWN_SPEC_MISMATCHES`（理由付きのスキップリスト）に載せて除外し、実行時に `skip` と表示します（現在は `GET /feature-flags/v1/me`: spec は認証不要だが実 API は 401）。
natsuneko の spec で条件を満たす操作は現状 2 件（`/catalyst/v1/announcements`、任意認証の `/catalyst/v1.1/timeline/newcomers`）のみのため、2 件以上あれば成功とし、3 件未満のときはその旨を表示します。

Archon のソースは `.js` 付きの相対 import を使っており Node の型除去だけでは読み込めないため、スクリプトは jiti 経由でソースと生成 SDK を読み込みます（事前の `pnpm build` は不要）。

## ライセンス

未定。
