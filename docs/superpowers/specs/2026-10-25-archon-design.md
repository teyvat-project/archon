# Archon — OpenAPI Meta SDK 設計仕様

- 日付: 2026-10-25
- ステータス: 承認済み（ブレインストーミング完了）
- 参照 spec: https://api.natsuneko.com/openapi.json（OpenAPI 3.1.0, 150 paths, 97 schemas）

## 1. 目的とスコープ

### 1.1 目的

任意の OpenAPI 3.0 / 3.1 仕様から、複数言語向けの **外部依存を最小化した** SDK を生成する汎用 OSS ジェネレータ（Meta SDK）を作る。カスタマイズ性は [Hey API (openapi-ts)](https://heyapi.dev/) を参考にする。

### 1.2 成功基準

- `api.natsuneko.com` の spec から全対象言語の SDK が生成でき、各言語のツールチェーンでコンパイルが通り、実 API / モックサーバに対して動作する。
- 全機能網羅の `fixtures/specs/edge-cases.yaml` に対して、全言語で同一の E2E シナリオが通る。
- 設定ファイル・フック・カスタムプラグインで、Hey API と同等水準の生成カスタマイズができる。

### 1.3 対象言語

| 言語 | ターゲット |
|---|---|
| TypeScript | Browser / Node.js 18+ / Bun / Deno / React Native / Cloudflare Workers（ESM のみ） |
| C# | .NET 10 |
| Kotlin | JVM 11+ / Android |
| Swift | Swift 6（Apple プラットフォーム / Linux） |
| Rust | stable（edition 2021） |
| Go | Go 1.22+ |

### 1.4 対象認証方式

Bearer Token / BASIC Auth / OAuth2（+ openIdConnect）/ API Key（header / query / cookie）。

### 1.5 スコープ外（現時点）

- Swagger 2.0 入力（変換ツールの利用を案内する）
- SSE / ストリーミングレスポンス
- OAuth2 Authorization Code / PKCE / Device Code フロー（アプリ側の責務）
- 「未設定」と「null」を区別する PATCH 用ラッパー型（将来オプション）
- ランタイムバリデーション（zod 等。将来プラグイン）
- `--watch` モード

## 2. 全体構成

### 2.1 名称と配布

- 名称: **Archon**。npm パッケージ `archon`（名称は公開前に再検討可）。
- CLI: `archon generate [-c archon.config.ts] [--plugin <name>] [--strict] [--verbose]`、`archon init`。
- Meta SDK 本体は TypeScript で実装し、依存ライブラリの使用は自由。

### 2.2 リポジトリ構成（pnpm workspace）

```
packages/archon/                 # 本体
  src/cli/                       # CLI エントリ
  src/config/                    # 設定定義・ロード（jiti）・デフォルト解決
  src/loader/                    # 入力取得（path / URL / object, JSON / YAML, $ref bundle）
  src/parser/                    # OpenAPI 3.0 / 3.1 → IR
  src/ir/                        # IR 型定義・ユーティリティ
  src/passes/                    # IR 変換パス
  src/plugin/                    # プラグイン API・ホスト・依存解決
  src/writer/                    # CodeWriter・ファイル出力・postProcess
  src/plugins/{typescript,csharp,kotlin,swift,rust,go}/
runtimes/{typescript,csharp,kotlin,swift,rust,go}/   # 手書きランタイム（各言語の通常プロジェクト、独自テスト付き）
fixtures/specs/                  # natsuneko.json, petstore.yaml, edge-cases.yaml
e2e/                             # モックサーバ + 各言語 E2E ランナー
docs/
```

### 2.3 アーキテクチャ方針

**IR + 言語別 Emitter プラグイン + Vendored Runtime** 方式。

- spec を言語非依存の IR に正規化し、言語プラグインが CodeWriter を使って IR からコードを出力する。
- HTTP 送信・認証・直列化・エラー・middleware 等の共通処理は **言語ごとの手書きランタイム** として実装し、生成時に出力先の `core/`（言語慣習に合わせた位置）へコピーする。生成 SDK は Archon 製ランタイムパッケージに依存しない。
- 生成コードは「型定義」と「操作（エンドポイント）定義」の薄い層に留める。

## 3. パイプライン

1. **Load** — path / URL（任意ヘッダ付き）/ object を受け付け、JSON / YAML を読み込み、外部 `$ref` を bundle する（内部 `$ref` は保持）。
2. **Patch** — `parser.patch` を生 spec に適用する。
3. **Parse** — OpenAPI 3.0 / 3.1 を IR に変換する。
4. **Passes**（順序固定、個別に無効化可）
   1. filters（operations / tags / schemas / deprecated）
   2. allOf 平坦化（全メンバーが object に解決できる場合はプロパティを合成。できない場合は `intersection` のまま）
   3. discriminator 推論（`inferDiscriminator`。union の全バリアントが object で、共通プロパティが `const` または単一値 enum の場合に discriminator を付与）
   4. inline schema 巻き上げと命名（言語プラグインが要求した場合。命名は `{Parent}{Prop}` 等、フック可）
   5. enum 巻き上げ（`transforms.enums: 'root'`）
   6. readWrite 分割（有効時）
   7. 命名衝突解決（接尾辞付与、`--verbose` でログ）
   8. orphan 除去（`filters.orphans: false` 時）
5. **Plugins** — 依存順（トポロジカルソート）に `transformIR` → `generate` を呼ぶ。
6. **Write** — `output.clean` の処理、ヘッダ付与、ファイル書き出し、`postProcess` コマンド実行。

## 4. IR

```ts
interface IRDocument {
  info: { title: string; version: string; description?: string };
  servers: IRServer[];                       // { url, description?, variables: Record<name, { default, enum? }> }
  securitySchemes: Map<string, IRSecurityScheme>;
  schemas: Map<string, IRSchema>;            // 名前付き schema（巻き上げ後のものを含む）
  operations: IROperation[];
}

type IRSecurityScheme =
  | { kind: 'http-bearer'; bearerFormat?: string }
  | { kind: 'http-basic' }
  | { kind: 'http-other'; scheme: string }                        // 未対応 → 警告
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2'; flows: IROAuthFlows }
  | { kind: 'openIdConnect'; url: string }
  | { kind: 'mutualTLS' };                                        // 未対応 → 警告

type IRSchema = IRSchemaBase & (
  | { kind: 'string'; format?: string; pattern?: string; minLength?: number; maxLength?: number }
  | { kind: 'integer'; format?: 'int32' | 'int64' }
  | { kind: 'number'; format?: 'float' | 'double' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'array'; items: IRSchema; uniqueItems?: boolean }
  | { kind: 'tuple'; items: IRSchema[]; rest?: IRSchema }
  | { kind: 'object'; properties: IRProperty[]; additionalProperties?: IRSchema | false }
  | { kind: 'enum'; base: 'string' | 'integer' | 'number'; values: (string | number)[] }
  | { kind: 'const'; value: unknown }
  | { kind: 'union'; variants: IRSchema[]; discriminator?: { property: string; mapping: Map<string, string> } }
  | { kind: 'intersection'; members: IRSchema[] }
  | { kind: 'ref'; name: string }
  | { kind: 'binary' }
  | { kind: 'unknown' }
);

interface IRSchemaBase {
  nullable: boolean;
  title?: string; description?: string; deprecated?: boolean;
  default?: unknown; example?: unknown;
  readOnly?: boolean; writeOnly?: boolean;
}

interface IRProperty { name: string; schema: IRSchema; required: boolean }

interface IROperation {
  id: string;                    // "GET /catalyst/v1/status/{id}"
  name: string;                  // operationId もしくは導出名
  group?: string;                // サービス分割キー（既定: 先頭 tag）
  method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
  path: string;
  tags: string[]; summary?: string; description?: string; deprecated: boolean;
  parameters: IRParameter[];     // path-level と operation-level をマージ済み
  requestBody?: { required: boolean; contents: IRMediaType[] };
  responses: IRResponse[];       // status: number | '1XX'..'5XX' | 'default'
  security: IRSecurityRequirement[];  // OR-of-AND。[] は認証なし、{} を含めば任意
  servers?: IRServer[];
}

interface IRParameter {
  name: string; in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean; deprecated: boolean; schema: IRSchema;
  style: 'simple' | 'label' | 'matrix' | 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';
  explode: boolean; allowReserved: boolean;
}

interface IRMediaType {
  mediaType: string;
  kind: 'json' | 'form' | 'multipart' | 'text' | 'binary';
  schema: IRSchema;
  encoding?: Map<string, { contentType?: string; style?: string; explode?: boolean }>;
}

interface IRResponse { status: number | string; description?: string; headers: Map<string, IRSchema>; contents: IRMediaType[] }
```

### 4.1 正規化規則

- nullable: 3.1 の `type: [X, "null"]`、3.0 の `nullable: true`、`anyOf/oneOf: [X, {type: null}]` はすべて `nullable: true` の X に正規化する。
- `type` 配列で null 以外が複数ある場合は union に変換する。
- `oneOf` と `anyOf` はともに `union` として扱う（生成コードでの意味論は同一：いずれかのバリアントとして解釈）。
- `$ref` の兄弟キーワード（3.1）は description 等のメタのみ反映する。
- `not`、`if/then/else`、`patternProperties` は警告を出して無視（`unknown` または無視）。
- media type 分類: `application/json` および `+json` → json、`application/x-www-form-urlencoded` → form、`multipart/*` → multipart、`text/*` → text、それ以外 → binary。
- 名前付き parameter / requestBody / response（`components.*`）は参照先を展開して操作に埋め込む。

### 4.2 操作名の導出

`operationId` がある場合はそれを使う。無い場合は `method` + パスセグメントを camelCase 化する。パスパラメータ `{x}` は `By` + `X` に変換する。

- `GET /catalyst/v1/album/by/id/{id}` → `getCatalystV1AlbumByIdById`
- `POST /catalyst/v1/album` → `postCatalystV1Album`

`parser.hooks.operationName(op, ctx)` で上書きできる（`undefined` を返すと既定にフォールバック）。言語プラグインは最終的な名前を各言語の命名規約に変換する。

## 5. 設定とカスタマイズ

### 5.1 設定ファイル

`archon.config.ts`（`.mts` / `.mjs` / `.js` / `.json` も可、ローダーは jiti）。

```ts
import { defineConfig } from 'archon';
import { typescript, csharp, kotlin, swift, rust, go } from 'archon/plugins';

export default defineConfig({
  input: 'https://api.natsuneko.com/openapi.json',  // string | { path, headers? } | OpenAPI object
  output: {
    path: './sdk',
    clean: true,                                      // 出力先を毎回クリア
    header: (ctx) => ctx.defaultValue,                // 生成物ヘッダ（行配列）の上書き
    postProcess: [{ command: 'prettier', args: ['--write', '{{path}}'] }],
  },
  parser: {
    filters: {
      operations: { include: ['/^GET /catalyst/'], exclude: ['DELETE /catalyst/v1/blocks'] },
      tags: { exclude: ['activitypub'] },
      schemas: { include: ['Status', '/^Album/'] },
      deprecated: false,
      orphans: false,
      preserveOrder: true,
    },
    patch: {
      document: (doc) => {},
      schemas: { Status: (schema) => {} },
      operations: { 'GET /catalyst/v1/status/{id}': (operation) => {} },
    },
    transforms: {
      enums: 'root',                    // 'root' | 'inline'
      inferDiscriminator: true,
      readWrite: false,                 // または { requests: '{{name}}Writable', responses: '{{name}}' }
      schemaName: 'Api{{name}}',        // テンプレートまたは (name) => string
    },
    hooks: {
      operationName: (op, ctx) => undefined,
      operationGroup: (op) => undefined,
      inlineSchemaName: (path, ctx) => undefined,
    },
  },
  plugins: [
    typescript({ output: 'ts' }),
    csharp({ output: 'csharp', namespace: 'Natsuneko.Api' }),
  ],
});
```

- **フィルタ構文**: 操作は `"METHOD /path"` 完全一致、または `/regex/` 文字列。include と exclude が両方一致した場合は exclude が優先される。
- **複数ジョブ**: `defineConfig([configA, configB])`。
- **フック規約**: すべてのフックは `undefined` を返すと既定動作にフォールバックする。

### 5.2 言語プラグイン共通オプション

| オプション | 内容 |
|---|---|
| `output` | `output.path` からのサブディレクトリ（既定: 言語名） |
| `package` | `false` でマニフェスト非生成。オブジェクトで name / version / description / license 等 |
| `naming` | `{ type, method, property, file }` ごとに `{ case, name }`（name はテンプレート） |
| `typeMappings` | `{ 'string:uuid': 'Guid', 'string:date-time': 'string' }` のような `type:format` → 言語型の上書き |
| `hooks` | `typeName`, `methodName`, `propertyName`, `fileName`, `typeOverride(schema, ctx)` |
| `include` / `exclude` | プラグイン単位の操作フィルタ（parser.filters と同じ構文） |

### 5.3 カスタムプラグイン API

```ts
import { definePlugin } from 'archon';

export const myPlugin = definePlugin<MyOptions>({
  name: 'my-plugin',
  dependencies: ['typescript'],   // 先に実行されるプラグイン。未登録なら既定設定で自動追加
  defaults: { /* ... */ },
  transformIR(ir, ctx) {},        // 生成前に IR を加工（全プラグインの generate より前に実行）
  generate(ctx) {
    // ctx.ir: IRDocument
    // ctx.options: 解決済みオプション
    // ctx.writer(language): CodeWriter
    // ctx.emit(relativePath, content)
    // ctx.plugin('typescript'): 依存プラグインの公開 API（symbols など）
    // ctx.logger
  },
});
```

言語プラグインは `symbols` API を公開する（例: `ctx.plugin('typescript').symbols.typeOf(schemaRef)` → 生成済み型名と import 元）。カスタムプラグインはこれを使い、生成 SDK を参照するコード（例: React Query フック）を追加できる。

### 5.4 CodeWriter

言語非依存の小さな出力ユーティリティ。インデント管理、ブロック、ドキュメントコメント、import / using 収集と重複排除、ファイル単位の識別子衝突解決、予約語エスケープ（言語プラグインが予約語表を提供）を担う。

## 6. 生成 SDK 共通仕様

### 6.1 Client

- 設定項目: `baseUrl`（既定は `servers[0]`。server variables は default で展開し、上書き可能）、`auth`、`headers`、`timeout`、`middleware`、`transport`。
- transport 差し替え: TS=`fetch` 関数、C#=`HttpClient`、Kotlin=Ktor `HttpClient` / engine、Swift=`URLSession`、Rust=`reqwest::Client`、Go=`*http.Client`。

### 6.2 Middleware

onion 型チェーン。interceptor 機構は持たない（middleware で表現する）。

```ts
type Middleware = (
  req: ApiRequest,
  next: (req: ApiRequest) => Promise<ApiResponse>,
  ctx: CallContext,
) => Promise<ApiResponse>;
```

- **順序**: 登録順に外側から実行する。組み込みの **認証適用は最内側**（transport 直前）で行うため、middleware が `next` を再度呼ぶと最新の資格情報が再適用される。
- **登録**: `createClient({ middleware: [...] })` および `client.use(mw)`。
- **CallContext**: `operationName`, `method`, `pathTemplate`, `tags`, `security`, `attempt`, キャンセル（`AbortSignal` / `CancellationToken` 等）, 任意キーの `extensions`。
- **リプレイ可能リクエスト**: body はバッファ済み（bytes / string / FormData）で保持し、何度でも再送できる。ストリーム body は `replayable = false` とし、リトライ系 middleware は再送しない。
- **標準 middleware（ランタイム同梱）**
  - `logging({ logger })` — `Authorization`、`Cookie`、`Proxy-Authorization`、API Key ヘッダ / クエリをマスク
  - `userAgent(value)`
  - `retry({ maxAttempts, baseDelay, maxDelay, statuses })` — 指数バックオフ + jitter。冪等メソッドのみ。429 / 503 では `Retry-After` を尊重
  - `retry401({ onUnauthorized })` — 401 受信時にコールバックを呼び、`true` なら 1 回だけ再送
- **言語別表現**
  - TS: 上記関数型
  - C#: `interface IApiMiddleware { Task<ApiResponse> InvokeAsync(ApiRequest, ApiNext, CallContext, CancellationToken) }`（`DelegatingHandler` を含む独自 `HttpClient` も注入可）
  - Kotlin: `fun interface Middleware { suspend fun intercept(request: ApiRequest, next: suspend (ApiRequest) -> ApiResponse, context: CallContext): ApiResponse }`
  - Swift: `protocol Middleware: Sendable { func intercept(_ request: ApiRequest, context: CallContext, next: @Sendable (ApiRequest) async throws -> ApiResponse) async throws -> ApiResponse }`
  - Rust: `trait Middleware: Send + Sync { fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>>; }`
  - Go: `type Middleware func(req *Request, next Next, ctx *CallContext) (*Response, error)`

### 6.3 パラメータ直列化

OpenAPI の `style` / `explode` を完全実装する。

- path: `simple`（既定）, `label`, `matrix`
- query: `form`（既定、explode=true）, `spaceDelimited`, `pipeDelimited`, `deepObject`
- header: `simple`
- cookie: `form`
- `allowReserved` に従いエンコードを抑制する。

### 6.4 Body / Response

- Request: JSON, `application/x-www-form-urlencoded`, `multipart/form-data`（ファイル: TS=`Blob | File`, C#=`Stream | byte[]` + ファイル名, Kotlin=`ByteArray` + ファイル名, Swift=`Data` + ファイル名, Rust=`Vec<u8>` / `reqwest::multipart::Part`, Go=`io.Reader` + ファイル名）, `application/octet-stream`, `text/plain`。requestBody に複数の content がある場合は優先順位 json > multipart > form > text > binary で 1 つを採用し、残りは info ログを出して無視する（`patch.operations` で変更可能）。
- Response: JSON / text / binary / 空（204, `Content-Length: 0`）。成功型は TS では全 2xx の型の union、他言語では最小ステータスの 2xx の型を採用する。

### 6.5 エラー

- 非 2xx: `ApiError`（status, headers, raw body, 該当ステータスの型付きエラーボディ）。
- 通信失敗 / タイムアウト / キャンセル: `TransportError` 系（言語慣習に従う）。
- デシリアライズ失敗: `DecodeError`（生 body を保持）。
- 必須認証が未設定: 送信前に `AuthError`。

### 6.6 前方互換

- enum は未知値フォールバックを持つ（`Unknown(raw)` 相当）。
- 未知プロパティは無視する。
- union で一致するバリアントが無い場合、可能な言語では `Unknown(raw JSON)` を保持する。

## 7. 言語別仕様

| | TypeScript | C# | Kotlin | Swift | Rust | Go |
|---|---|---|---|---|---|---|
| API 形状 | `getX({ client, path, query, body })` 関数（`sdk.style: 'class'` 可） | `client.Catalyst.GetXAsync(...)` | `client.catalyst.getX(...)` suspend | `client.catalyst.getX(...)` async throws | `client.catalyst().get_x(...).await` | `client.Catalyst.GetX(ctx, params)` |
| 結果 | `{ data, error, response }`（`throwOnError` で例外） | 戻り値 + `ApiException<T>` | 戻り値 + `ApiException` | 戻り値 + `throws ApiError` | `Result<ApiResponse<T>, Error<E>>` | `(*T, *http.Response, error)` |
| 依存 | なし（fetch） | なし（BCL、System.Text.Json source generation で AOT 対応） | Ktor client + kotlinx.serialization | なし（Foundation） | reqwest + serde + serde_json + tokio | なし（stdlib） |
| date-time | `string`（opt `Date`） | `DateTimeOffset` | `String`（opt `kotlinx.datetime.Instant`） | `Date` | `String`（opt `chrono`） | `time.Time` |
| int64 | `number`（opt `bigint`） | `long` | `Long` | `Int64` | `i64` | `int64` |
| uuid | `string` | `Guid` | `String` | `UUID` | `String`（opt `uuid`） | `string` |
| uri | `string` | `string` | `String` | `String` | `String` | `string` |
| nullable / optional | `p?: T \| null` | `T?` | `T? = null` | `T?` | `Option<T>` + `skip_serializing_if` | `*T` + `omitempty` |
| union（判別あり） | union 型 | `[JsonPolymorphic]` 基底クラス | sealed class + discriminator | enum（関連値）+ Codable | `#[serde(tag = "...")]` enum | 構造体 + 自前 `UnmarshalJSON` |
| union（判別なし） | union 型 | 自前 `JsonConverter`（順に試行） | `JsonContentPolymorphicSerializer` | 順に試行する enum | `#[serde(untagged)]` enum | 順に試行 |
| enum | 文字列リテラル union（opt `const` / `enum`） | enum + 未知値対応 converter | enum + 未知値 | `enum` + `.unknown(String)` | enum + `Unknown(String)` | `type X string` + 定数 |
| 予約語 | 末尾 `_` | `@` プレフィックス | バッククォート | バッククォート | `r#` | 末尾 `_` |
| マニフェスト | `package.json` + `tsconfig.json` | `.csproj`（net10.0） | `build.gradle.kts` | `Package.swift` | `Cargo.toml` | `go.mod` |

- TS 以外では inline object / enum を巻き上げて命名する（`{Parent}{Prop}`）。TS は既定で inline のまま出力する。
- C#: nullable reference types 有効、`required` メンバー、`System.Text.Json` source generation、`CancellationToken` を全メソッドに付与。
- Kotlin: Android 互換のため既定 engine は OkHttp ではなく利用者選択（`HttpClient` を受け取る）。生成側は `ktor-client-core` と `kotlinx-serialization-json` のみに依存する。
- Swift: `Sendable` 準拠、`Codable`、Linux では `FoundationNetworking` を条件 import する。
- Rust: `reqwest` は `default-features = false` + `json` / `multipart` を有効化し、TLS は feature で選択（`rustls-tls` 既定）。
- Go: `context.Context` を第 1 引数に取る。

## 8. 認証

### 8.1 設定

securitySchemes 名をキーとする。生成 SDK はスキーム名から型付きの `auth` 設定を生成する。

```ts
auth: {
  bearerAuth: 'token' | (() => Promise<string>),
  basicAuth: { username, password } | (() => Promise<{ username: string; password: string }>),
  apiKey: 'key' | (() => Promise<string>),                // in / name は spec に従う
  oauth2: {
    accessToken?: string | (() => Promise<string>),
    clientCredentials?: { clientId, clientSecret, scopes?, tokenUrl? },
    refreshToken?: { refreshToken, clientId, clientSecret?, tokenUrl?, onRefreshed?(tokens) },
  },
}
```

### 8.2 適用規則

- 操作の `security`（OR-of-AND）を先頭から評価し、設定済みスキームだけで満たせる最初の代替を適用する。
- 代替に `{}`（任意認証）が含まれ、他を満たせない場合は認証なしで送信する。
- 必須認証が満たせない場合は送信前に `AuthError` を出す。
- 適用は middleware チェーンの最内側で行う。

### 8.3 OAuth2 トークンマネージャ

- `clientCredentials` / `refreshToken` で取得したトークンを有効期限付きでキャッシュする。
- 期限の 30 秒前に先回りで更新する。
- 同時リクエスト時の更新は single-flight で 1 回にまとめる。
- 401 を受けたら 1 回だけ強制更新して再送する。
- `tokenUrl` の既定は spec の `flows.clientCredentials.tokenUrl` / `flows.*.refreshUrl`。
- scope は操作の要求 scope を合算して要求する。
- `openIdConnect` は discovery を行わず OAuth2 と同様に扱う（`tokenUrl` を明示）。

### 8.4 未対応スキーム

`http` の bearer / basic 以外（digest 等）と `mutualTLS` は生成時に警告を出す。生成 SDK では `customAuth: (req) => void` フックと transport 設定（クライアント証明書）で対応する。

### 8.5 セキュリティ配慮

- Logging middleware は資格情報をマスクする。
- `baseUrl` と異なるオリジンへのリダイレクト時は `Authorization` / API Key ヘッダを送らない（各 transport の既定挙動を検証し、必要なら手動リダイレクト処理で担保する）。

## 9. 生成器のエラーと警告

- spec の構造エラー（壊れた `$ref`、不正な型）: JSON Pointer 付きで停止する。
- 継続可能な未対応（未対応 auth、`not`、`if/then/else`、未知 media type）: 警告を出し `unknown` / 生 bytes にフォールバックする。`--strict` で警告をエラーとして扱う。
- 命名衝突: 自動解決（接尾辞付与）。`--verbose` で改名内容をログに出す。

## 10. テスト戦略

1. **単体**（vitest）: loader、parser（3.0 / 3.1 差異）、各 pass、操作名導出、CodeWriter、parameter serializer の仕様表テスト。
2. **スナップショット**: `fixtures/specs/*` × 各言語プラグインの生成物。
3. **コンパイル**: 生成物に対し `tsc --noEmit` / `dotnet build` / `gradle build` / `swift build` / `cargo check` / `go vet`。ツールチェーンが無い言語はローカルでは skip し、CI では全言語を実行する。
4. **ランタイム E2E**: `edge-cases.yaml` を実装した Node 製モックサーバに対し、各言語の生成 SDK で同一シナリオ（全 param style、全 body 種別、union / enum 未知値、各 auth、middleware 順序 / リトライ / 401 リフレッシュ、エラー型）を実行する。
5. **ライブスモーク**（手動）: api.natsuneko.com の認証不要 GET。

## 11. マイルストーン

各マイルストーンは「生成 → コンパイル → E2E 通過」で完了とする。

- **M1**: コア（loader / parser / IR / passes / 設定 / プラグイン API / CLI / CodeWriter）+ TypeScript プラグイン & ランタイム + モックサーバ + E2E 基盤
- **M2**: C#
- **M3**: Kotlin
- **M4**: Swift
- **M5**: Rust
- **M6**: Go

M2 以降は M1 完了後に、本仕様を元に言語ごとに実装計画を作成して進める。
