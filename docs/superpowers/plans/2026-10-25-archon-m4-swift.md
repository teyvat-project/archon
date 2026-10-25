# Archon M4（Swift）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swift 6 言語プラグインと、外部依存ゼロ（Foundation のみ）の手書き Swift ランタイムを実装する。`edge-cases.yaml` と `natsuneko.json` から生成した Swift パッケージが `swift build -Xswiftc -warnings-as-errors`（Swift 6 言語モード、strict concurrency）を警告ゼロで通り、TypeScript / C# と同じ E2E シナリオがモックサーバに対して通ることを完了条件とする。

**Architecture:** `runtimes/swift` に SwiftPM パッケージ（ソースは `src/`、テストは `tests/`、モジュール名 `ArchonRuntime`）を置き、生成時に出力先 `Sources/<Module>Core/` へそのままコピーする（別ターゲットにすることで、モデル名が `Error` / `Date` / `Data` でもランタイムのコードが影響を受けない）。Swift プラグイン（`packages/archon/src/plugins/swift`）は inline の object / enum / union を巻き上げた IR から、モデル（`Sources/<Module>/Models/*.swift`）、タグ別サービス（`Services/*.swift`）、`ApiClient` / `ApiAuth`、`Exports.swift`（`@_exported import <Module>Core`）、`Package.swift` を出力する。E2E は既存の `e2e/mock-server` を Node スクリプトで起動し、生成パッケージに依存する swift-testing のテストパッケージを `swift test` で実行する。

**Tech Stack:** Swift 6.0+（tools-version 6.0、Swift 6 言語モード）, Foundation / FoundationNetworking（Linux）, swift-testing（`import Testing`。ツールチェーン同梱）, 既存の Node 24 / pnpm 10 / vitest / jiti

**Spec:** `docs/superpowers/specs/2026-10-25-archon-design.md`（特に §6 生成 SDK 共通仕様、§7 Swift 列、§8 認証、§10 テスト戦略）。構成と規約は M1 / M2 の計画（`2026-10-25-archon-m1-core-typescript.md` / `2026-10-25-archon-m2-csharp.md`）に従う。M3（Kotlin）は未着手だが M4 は M3 に依存しない。

## Global Constraints

- 生成 Swift SDK とランタイムの依存は Foundation のみ（`dependencies: []`）。Linux では `#if canImport(FoundationNetworking)` で `FoundationNetworking` を import する（spec §7）。
- 生成 `Package.swift`: `swift-tools-version:6.0`、platforms は macOS 12 / iOS 15 / tvOS 15 / watchOS 8 / visionOS 1、ターゲットは `<Module>Core`（ランタイム）と `<Module>`（生成コード、`<Module>Core` に依存）、プロダクトは `<Module>` のみ。生成コードは `swift build -Xswiftc -warnings-as-errors` で警告ゼロ。
- 公開型はすべて `Sendable`。モデルは `Codable, Hashable, Sendable` の struct / enum（spec §7）。middleware・認証プロバイダなどのクロージャは `@Sendable`。
- 型対応（spec §7 Swift 列）: `date-time` → `Date`、`int64` → `Int64`、`uuid` → `UUID`、`uri` → `String`、nullable / optional → `T?`。
- 判別あり union → 関連値付き enum（判別値で振り分け）、判別なし union → 関連値付き enum（バリアントを宣言順に試行）、どちらも一致しなければ `.unknown(JSONValue)`。enum → `.unknown(String)`（数値 enum は `.unknown(Int)` / `.unknown(Double)`）を持つ enum（spec §7、§6.6）。
- 予約語はバッククォート（spec §7）。
- API 形状は `client.<group>.<method>(...) async throws`、戻り値は成功ボディ、非 2xx は `throws ApiError`（spec §7）。
- Middleware は `protocol Middleware: Sendable { func intercept(_ request: ApiRequest, context: CallContext, next: @Sendable (ApiRequest) async throws -> ApiResponse) async throws -> ApiResponse }`（spec §6.2）。登録順に外側から実行し、認証適用は最内側（transport 直前）。
- 標準 middleware: logging（`Authorization` / `Cookie` / `Proxy-Authorization` / `Set-Cookie` / apiKey ヘッダ・クエリをマスク）、userAgent、retry（指数バックオフ + equal jitter、冪等メソッドのみ、429 / 503 は `Retry-After` を尊重）、retry401（コールバックが true なら 1 回だけ再送）。既定値は TS / C# と同一。
- 認証: OR-of-AND を先頭から評価、`{}` は他を満たせないときだけ匿名送信、必須認証が満たせなければ送信前に `AuthError`。OAuth2 は期限 30 秒前に先回り更新、更新は single-flight（actor）、管理トークンで 401 を受けたら 1 回だけ強制更新して再送（spec §8）。
- `baseUrl` と異なるオリジンへのリダイレクトでは `Authorization` / `Cookie` / apiKey ヘッダ・クエリを送らない（spec §8.5）。リダイレクトはランタイムが手動で追う（既定の `URLSessionTransport` は URLSession の自動リダイレクトを止める）。
- パラメータ直列化・エンコード結果は TS ランタイムと一致させる。ただし Foundation の `URL` が受け付けない文字（下記「意図的な差分」）は percent-encode する。
- requestBody の media type 優先順は json > multipart > form > text > binary（IR で並べ替え済み、`contents[0]` を採用）。
- 生成物の各ファイル先頭には生成ヘッダ（`// ` コメント、`output.header` で上書き可。`Package.swift` だけは 1 行目の `// swift-tools-version` の後）を付与する。

## Spec からの M4 における意図的な差分

- **URL に使えない文字は常に percent-encode する**: Foundation の `URL(string:)` は RFC 3986 で不正な文字（`|` `[` `]` `{` `}` `"` `<` `>` `\` `^` `` ` `` と空白・非 ASCII）を 1 つでも含むと、既存の `%XX` まで `%25XX` に再エンコードしてしまう（プロトタイプで確認）。そのため path / query の直列化では、TS で素通しになる `|`（pipeDelimited の区切り）と deepObject の `[` `]`、allowReserved で戻した `#` `[` `]` もエンコードする（`piped=1%7C2`、`filter%5Bstatus%5D=active`）。サーバー側でデコードした値は TS と同じ。
- **JSON の直列化はランタイム自前**: `JSONEncoder` はキー順を保持せず（`/` も `\/` にする）、deepObject / form / multipart の値やボディの順序が宣言順にならない。そこで `Encodable` を順序付きの `JSONValue` に変換する `JSONValueEncoder` と、`JSON.stringify` と同じ書式で出力するシリアライザをランタイムに持つ。デコードは Foundation の `JSONDecoder`（日時は RFC 3339 の自前パーサ）を使う。
- **`date` は `CalendarDate`**（ランタイムの年月日 struct、`"YYYY-MM-DD"` で Codable）。Foundation に日付のみの型が無いため。`time` は `String`。`byte` は `Data`（base64）。integer は format 無しが `Int`、`int32` が `Int32`、`int64` が `Int64`。
- **判別あり union のバリアントは判別プロパティを保持する**（Swift の enum + Codable には C# のような制約が無い）。const / 単一値 enum の判別プロパティはイニシャライザの既定値にする（`Circle(radius: 1)`）。未知の判別値は `.unknown(JSONValue)` で生 JSON ごと保持する。
- **union は常に `indirect enum`**、struct だけで閉じる値の循環（`A.b: B?` と `B.a: A?`、`Node.parent: Node?`）は該当プロパティをランタイムの `Indirect<T>` に格納する（Swift の値型は自分自身を値で含めない）。配列・辞書の要素はヒープなので対象外。
- **非 2xx は単一の `ApiError`**（`statusCode` / `headers` / `url` / `rawBody` / `body: (any Sendable)?`、`body(as:)`）。Swift はジェネリックなエラー型を `catch` で扱いにくいため、型付きボディは `body as? NotFoundError` で取り出す。通信失敗・タイムアウトは `TransportError`（`timedOut`）、デコード失敗は `DecodeError`、認証不足は `AuthError`。呼び出し側の Task キャンセルは Swift の慣習どおり `CancellationError`。
- **空の JSON 応答**: 戻り値型が Optional（schema が nullable）なら `nil`、そうでなければ `DecodeError`（Swift の非 Optional 型には「値なし」を表せない）。204 など content の無い成功は `Void`（`ApiResult<Void>`）。
- **ボディは常にバッファ済み**（`Data`）。ストリーム body は扱わないので、ランタイムが作るリクエストはすべて replayable（`ApiRequest.replayable` は自作リクエスト用に残す）。
- **バイナリ**: リクエストの binary body は `Data`、レスポンスの binary は `Data`、モデル内（multipart のファイル部など）の binary は `ApiFile`（`Data` + ファイル名 + Content-Type、JSON では base64）。
- **`throwOnError` は無い**（C# と同じく常に throw）。ステータスやヘッダが必要な呼び出し側のために、各操作に `<method>WithResponse`（`ApiResult<T>` を返す）を併せて生成する。
- **ランタイムの単体テストはモック transport で行う**（Swift の Foundation には HTTP サーバー API が無い）。`URLSessionTransport` 自体は E2E（実 HTTP）で検証する。
- **名前の衝突**: モデル名がランタイムの型名（`ApiRequest` など）・`ApiAuth`・クライアント名・サービス名・モジュール名・`Swift` / `Foundation` / `FoundationNetworking` と衝突する場合、および Swift で宣言できない名前（`Type` / `Self` / `Protocol` / `Any` / `AnyObject`）は接尾辞を付ける。標準ライブラリ・Foundation の型名（`Error` / `Date` / `Data` / `String` …）と同名のモデルはそのまま宣言し、生成コード側がその型を参照するときだけ `Swift.` / `Foundation.` で修飾する。

## Review Focus

- **Swift 識別子として不正・衝突する名前**（プロパティ `x-foo` / `2fa` / `class` / `self` / `foo_bar` と `fooBar`、schema 名 `Foo.Bar` / `1Thing` / `Error` / `Type` / `ApiRequest`、enum 値 `""` / `default` / `unknown` / `1`、パラメータ `id` が path と query の両方、パラメータ名 `options`）→ camelCase / PascalCase、先頭数字は `_`、キーワードはバッククォート、衝突は接尾辞、ワイヤ名は `CodingKeys` の raw value で保持。→ Task 5、Task 6、Task 7 の stress spec。
- **値型の循環**（`Node.children: [Node]` は可、`Node.parent: Node?` / `A↔B` / union を経由する循環）→ `Indirect` と `indirect enum` で `swift build` が通る。→ Task 5、Task 7。
- **path / query の値に予約文字・非 ASCII**（`a/b?c#d e`、`日本`、`|`、`[`、既存の `%41`）→ 1 セグメントに収まり、`URL` が再エンコードしない。→ Task 1、Task 8。
- **同時リクエストと OAuth2 更新**（コールドクライアントで 5 並行、呼び出し側の 1 つがキャンセル）→ トークン取得は 1 回、キャンセルした呼び出しだけが `CancellationError`。→ Task 3。
- **Swift 6 strict concurrency**（`Sendable` 漏れ、`static let` の非 Sendable、actor 隔離）→ ランタイムとすべての生成物が Swift 6 言語モードで警告ゼロ。→ Task 7。

---

## File Structure

```
packages/archon/
  src/plugins.ts                         # Task 5: swift を export
  src/plugins/swift/
    index.ts        # definePlugin 本体・オプション・symbols API
    reserved.ts     # Swift キーワード、宣言できない型名、修飾が必要になり得る標準型名
    names.ts        # 型名・メンバー名・enum case 名の決定、修飾（SwiftNames）
    types.ts        # IRSchema → Swift 型（SwTypeResolver）、値の循環検出
    emit.ts         # ファイル先頭、doc コメント、文字列リテラル
    models.ts       # Models/*.swift（struct / enum / union enum）
    services.ts     # Services/*.swift（操作 spec、メソッド、エラーデコーダ）
    client.ts       # ApiClient.swift、ApiAuth.swift、Exports.swift
    package.ts      # Package.swift
    runtime.ts      # ランタイムの読み込みと型名一覧
  test/plugins/swift/{helpers,names,types,models,services,client,runtime}.test.ts
  test/e2e-generate/snapshot.test.ts     # Task 7: Swift を追加
  test/e2e-generate/swift-compile.test.ts
  test/e2e-generate/__snapshots__/swift/{petstore,edge-cases}/**

runtimes/swift/
  Package.swift                          # ArchonRuntime（path: src）+ ArchonRuntimeTests（path: tests）
  src/{Specs,JSONValue,JSONValueEncoder,JSONCoding,RFC3339,CalendarDate,ApiFile,Indirect,ApiHeaders,
       PercentEncoding,ParameterSerializer,RequestValues,Bodies,ApiRequest,ApiResponse,Errors,Decoders,
       Middleware,Transport,ClientOptions,ApiClientCore,Auth,OAuth2TokenManager,StandardMiddleware,Lock}.swift
  tests/*.swift                          # swift-testing。MockTransport で HTTP を偽装

e2e/swift/
  package.json                           # @natsuneko-laboratory/archon-e2e-swift（private）
  Package.swift                          # generated/EdgeCases に path 依存
  scripts/run.mjs                        # 生成 → モック起動 → swift test → 終了
  scripts/generate.mjs
  Tests/ArchonE2ETests/{Support,Params,Bodies,Responses,Unions,Auth,Middleware,Errors,Redirect}Tests.swift
```

ルート `package.json` に `"test:e2e:swift"`、`.gitignore` に `e2e/swift/generated/`, `**/.build/`, `**/.swiftpm/` を追加する。CI に `runtime-swift`（`swift test --package-path runtimes/swift`）と `e2e-swift` を追加し、`test` ジョブにも Swift を入れて compile テストを走らせる。

### 依存してよいもの

`runtimes/swift/src` と生成 SDK: Foundation（+ FoundationNetworking）のみ。テスト: swift-testing（ツールチェーン同梱）。`packages/archon` の依存は増やさない。

---

## Task 1: Swift runtime — scaffold / spec 型 / JSON / パラメータ直列化

**Files:**
- Create: `runtimes/swift/Package.swift`, `runtimes/swift/src/{Specs,JSONValue,JSONValueEncoder,JSONCoding,RFC3339,CalendarDate,ApiFile,Indirect,ApiHeaders,PercentEncoding,ParameterSerializer,Lock}.swift`, `runtimes/swift/tests/{ParameterSerializerTests,JSONTests}.swift`
- Modify: `.gitignore`, `packages/archon/scripts/copy-runtimes.mjs`（`.build` / `.swiftpm` / `Package.swift` を除外）

**Interfaces（Produces）:**
```swift
public enum HTTPMethod: String, Sendable { case get = "GET", put = "PUT", post = "POST", delete = "DELETE", options = "OPTIONS", head = "HEAD", patch = "PATCH", trace = "TRACE" }
public enum ParamLocation: Sendable { case path, query, header, cookie }
public enum ParamStyle: Sendable { case simple, label, matrix, form, spaceDelimited, pipeDelimited, deepObject }
public struct ParamSpec: Sendable { init(_ name: String, _ location: ParamLocation, _ style: ParamStyle, explode: Bool, allowReserved: Bool = false) }
public enum BodyKind: Sendable { case json, form, multipart, text, binary }
public enum ResponseKind: Sendable { case json, text, binary, empty }
public enum ApiKeyLocation: Sendable { case header, query, cookie }
public enum SecuritySchemeSpec: Sendable { case httpBearer, httpBasic, apiKey(ApiKeyLocation, name: String), oauth2(tokenUrl: String?, refreshUrl: String?), openIdConnect }
public struct SecurityScheme: Sendable { init(_ name: String, scopes: [String] = []) }
public struct SecurityRequirement: Sendable { init(_ schemes: [SecurityScheme]) }      // [] = 任意認証
public struct OperationSpec: Sendable { init(operationName:method:path:tags:security:params:body:bodyMediaType:responses:) }  // responses: ['200' | '2XX' | 'default': ResponseKind]
public enum JSONValue: Codable, Hashable, Sendable { case null, bool(Bool), int(Int64), double(Double), string(String), array([JSONValue]), object(JSONObject) }
public struct JSONObject: Hashable, Sendable, Sequence, ExpressibleByDictionaryLiteral { subscript(key: String) -> JSONValue? }  // 挿入順を保持
public struct JSONValueEncoder { func encode<T: Encodable>(_ value: T) throws -> JSONValue }   // Date → RFC 3339（ミリ秒、Z）、Data → base64、URL → 文字列
public enum ApiJSON { static func encode<T: Encodable>(_ value: T) throws -> Data; static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T; static func serialize(_ value: JSONValue) -> String }
public enum RFC3339 { static func parse(_ text: String) -> Date?; static func format(_ date: Date) -> String }
public struct CalendarDate: Codable, Hashable, Comparable, Sendable, CustomStringConvertible { init(year:month:day:); init?(_ text: String) }
public struct ApiFile: Codable, Hashable, Sendable { init(_ data: Data, fileName: String? = nil, contentType: String? = nil) }
public final class Indirect<Value: Sendable>: Sendable { let value: Value }   // Hashable / Codable は Value に従う
public struct ApiHeaders: Sendable, Hashable, Sequence, ExpressibleByDictionaryLiteral { subscript(name: String) -> String? { get set }; func contains(_:); mutating func remove(_:) }  // 大文字小文字無視、挿入順、1 名 1 値
enum PercentEncoding { static func component(_ s: String) -> String; static func reserved(_ s: String) -> String; static func form(_ s: String) -> String }
enum ParameterSerializer { static func path(_ template: String, _ specs: [ParamSpec], _ values: RequestValues) throws -> String; static func query(...) -> String; static func header(_ spec: ParamSpec, _ value: JSONValue) throws -> String?; static func cookie(...) -> String? }
```
エンコード: `component` は `encodeURIComponent` と同じ（`A–Z a–z 0–9 - _ . ! ~ * ' ( )` 以外を UTF-8 の `%XX` 大文字に）。`reserved` は `: / ? @ $ & + , ; =` を戻す（`#` `[` `]` は戻さない。意図的な差分）。pipeDelimited の区切りは `%7C`、deepObject の括弧は `%5B` / `%5D`。`form` は `URLSearchParams` と同じ（英数字と `* - . _` 以外を `%XX`、空白は `+`）。path の値が空・`.`・`..` のセグメントになる場合、必須 path パラメータが無い場合、header 値の CR / LF は `ArgumentError`（`Error`、送信前）。値は `JSONValueEncoder` で `JSONValue` にしてから直列化する（キー順は宣言順、null は出力しない、int は整数表記、double は JS と同じ最短表記）。

- [ ] **Step 1:** 失敗するテストを書く。M1 Task 13 の表（matrix / label / simple / form × explode、spaceDelimited / pipeDelimited / deepObject、値 `blue` / `[blue,black,brown]` / `{R:100,G:200,B:150}`）を全行、区切り文字だけ差分に合わせて検証する。追加: 予約文字・非 ASCII の path、`allowReserved` の `a/b?c:d`、`!'()*~` がそのまま、null の省略、Date と enum の直列化、cookie の `; ` 連結、`.` セグメントの拒否、header の CR / LF 拒否、form エンコード、`JSONValue` の往復、`ApiJSON.encode` が宣言順で `/` をエスケープしないこと、RFC 3339 のオフセット・小数秒、`CalendarDate` の Codable。
- [ ] **Step 2:** `swift test --package-path runtimes/swift` → ビルドエラー。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS（警告ゼロ）。
- [ ] **Step 5:** Commit `feat(runtime-swift): add spec types, JSON coding and parameter serialization`。

## Task 2: Swift runtime — body / transport / client core / middleware chain

**Files:**
- Create: `runtimes/swift/src/{RequestValues,Bodies,ApiRequest,ApiResponse,Errors,Decoders,Middleware,Transport,ClientOptions,ApiClientCore}.swift`, `runtimes/swift/src/Auth.swift`（このタスクでは何もしないスタブ）
- Test: `runtimes/swift/tests/{MockTransport,BodyTests,ClientCoreTests,RedirectTests}.swift`

**Interfaces（Produces）:**
```swift
public struct RequestValues: Sendable { init(); mutating func path<T: Encodable>(_ name: String, _ value: T?) throws  // query / header / cookie も同形
  mutating func json<T: Encodable>(_ body: T) throws; mutating func form<T: Encodable>(_ body: T) throws; mutating func multipart(_ body: MultipartBody)
  mutating func text(_ body: String); mutating func binary(_ body: Data) }
public struct MultipartBody: Sendable { init(); mutating func field<T: Encodable>(_ name: String, _ value: T?) throws; mutating func file(_ name: String, _ file: ApiFile?); mutating func files(_ name: String, _ files: [ApiFile]?) }
public struct ApiRequest: Sendable { var method: HTTPMethod; var url: URL; var headers: ApiHeaders; var body: Data?; var replayable: Bool; mutating func setQueryParameter(_ name: String, _ value: String) }
public struct ApiResponse: Sendable { var statusCode: Int; var headers: ApiHeaders; var url: URL; var body: Data }
public struct ApiResult<T: Sendable>: Sendable { statusCode; headers; url; data: T }
public struct ApiError: Error { statusCode; headers; url; rawBody: Data; body: (any Sendable)?; var rawText: String?; func body<T>(as: T.Type) -> T? }
public struct TransportError: Error { message; timedOut: Bool; underlying: (any Error)? }
public struct DecodeError: Error { statusCode; rawBody: Data; message }
public struct AuthError: Error { schemes: [String]; message }
public struct ArgumentError: Error { message }
public struct ResponseDecoder<T: Sendable>: Sendable { static func json(_ type: T.Type) -> Self where T: Decodable; static var text / binary }
public struct ErrorDecoders: Sendable { init(); func json<T: Decodable & Sendable>(_ status: String, _ type: T.Type) -> Self; func text(_ status: String) -> Self; static let none }
public typealias Next = @Sendable (ApiRequest) async throws -> ApiResponse
public protocol Middleware: Sendable { func intercept(_ request: ApiRequest, context: CallContext, next: @Sendable (ApiRequest) async throws -> ApiResponse) async throws -> ApiResponse }
public struct ClosureMiddleware: Middleware { init(_ fn: @escaping @Sendable (ApiRequest, CallContext, Next) async throws -> ApiResponse) }
public final class CallContext: @unchecked Sendable { operationName; method; pathTemplate; tags; security; var attempt: Int; redactHeaders: Set<String>; redactQuery: Set<String>; var extensions: [String: any Sendable] }
public protocol HTTPTransport: Sendable { func send(_ request: ApiRequest) async throws -> ApiResponse }   // リダイレクトを追わないこと
public final class URLSessionTransport: HTTPTransport { init(configuration: URLSessionConfiguration = .ephemeral); init(session: URLSession) }
public protocol AuthConfig: Sendable { func value(for scheme: String) -> AuthValue? }
public struct ClientOptions: Sendable { var baseUrl: String; var auth: (any AuthConfig)?; var headers: ApiHeaders; var timeout: Double?; var middleware: [any Middleware]; var transport: (any HTTPTransport)?; var customAuth: CustomAuth? }
public struct RequestOptions: Sendable { var headers: ApiHeaders; var extensions: [String: any Sendable]; var baseUrl: String? }
public final class ApiClientCore: @unchecked Sendable { init(options: ClientOptions, securitySchemes: [String: SecuritySchemeSpec]); var options: ClientOptions { get set }; func use(_ middleware: any Middleware)
  func send<T>(_ op: OperationSpec, _ values: RequestValues, decoder: ResponseDecoder<T>, errors: ErrorDecoders, options: RequestOptions?) async throws -> ApiResult<T>
  func send(_ op: OperationSpec, _ values: RequestValues, errors: ErrorDecoders, options: RequestOptions?) async throws -> ApiResult<Void> }
```
挙動は M1 Task 14 / M2 Task 3 と同じ規則（URL の結合、ヘッダ順 `options.headers` → header パラメータ → `RequestOptions.headers` → Cookie → Content-Type → Accept、チェーン `[...middleware（スナップショット）, auth]`、`ctx.attempt` は 1 から、成功は decoder、非 2xx は `status` → `NXX` → `default` の順で errors を引いて `ApiError`（デコード失敗・空 body は `body == nil`））。JSON body は `Content-Type: <mediaType>`、form は `application/x-www-form-urlencoded`（配列は繰り返しキー、object は JSON 文字列、null は省略）、multipart は自前で `multipart/form-data; boundary=archon-<UUID>` を組み立てる（`Content-Disposition: form-data; name="…"; filename="…"`、ファイル部の `Content-Type` は `ApiFile.contentType ?? application/octet-stream`）。リダイレクト（301 / 302 / 303 / 307 / 308 + `Location`、最大 20 回）、オリジン変更時の資格情報除去、303 と POST の 301 / 302 の GET 化、タイムアウト（`TransportError(timedOut: true)`。Task グループで transport と競争させる）は transport の外側でランタイムが行う。`URLSessionTransport` は `httpShouldSetCookies = false`・`httpCookieStorage = nil`・`urlCache = nil` のセッションと、リダイレクトを止めるデリゲートを使い、`URLError.cancelled` かつ Task がキャンセル済みなら `CancellationError`、それ以外の `URLError` は `TransportError`。

- [ ] **Step 1:** 失敗するテストを書く（`MockTransport` は受け取ったリクエストを記録し、テストごとの応答を返す）: JSON / form / multipart / text / binary の body、`baseUrl` のパス保持、`a%2Fb` と `%41` が書き換わらない、2xx の型付きデータ、404 の型付き `ApiError`、JSON でないエラー body、204 と空 JSON（Optional なら nil、非 Optional なら `DecodeError`）、不正 JSON の `DecodeError`、タイムアウト、キャンセル、middleware の順序 `["mw1:before","mw2:before","auth","mw2:after","mw1:after"]`、`use` の追加、クロスオリジンのリダイレクトで資格情報が落ちる、同一オリジンでは残る、303 の GET 化。
- [ ] **Step 2:** FAIL を確認する。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** Commit `feat(runtime-swift): add client core, transport, bodies and middleware chain`。

## Task 3: Swift runtime — 認証 / OAuth2 トークンマネージャ

**Files:**
- Create: `runtimes/swift/src/OAuth2TokenManager.swift`
- Modify: `runtimes/swift/src/Auth.swift`
- Test: `runtimes/swift/tests/{AuthTests,OAuth2TokenManagerTests}.swift`

**Interfaces（Produces）:**
```swift
public struct TokenValue: Sendable, ExpressibleByStringLiteral { init(_ token: String); init(provider: @escaping @Sendable () async throws -> String) }
public struct BasicCredentials: Sendable, Hashable { username; password }
public struct BasicValue: Sendable { init(username: String, password: String); init(provider: @escaping @Sendable () async throws -> BasicCredentials) }
public enum OAuth2ClientAuth: Sendable { case basic, post }
public struct OAuth2ClientCredentials: Sendable { init(clientId:clientSecret:scopes:tokenUrl:clientAuth:) }
public struct OAuth2RefreshToken: Sendable { init(refreshToken:clientId:clientSecret:tokenUrl:clientAuth:onRefreshed:) }
public struct OAuth2Value: Sendable { init(accessToken:clientCredentials:refreshToken:) }
public enum AuthValue: Sendable { case token(TokenValue), basic(BasicValue), oauth2(OAuth2Value) }
public struct TokenSet: Sendable, Hashable { accessToken; refreshToken; expiresAt: Date?; scope }
public enum Selection: Sendable, Equatable { case apply(SecurityRequirement), anonymous, missing([String]) }
public enum SecuritySelector { static func select(_ requirements: [SecurityRequirement], isConfigured: (String) -> Bool) -> Selection }
public actor OAuth2TokenManager { init(transport: any HTTPTransport, config: OAuth2Value, tokenUrl: String?, baseUrl: String?, scheme: String, now: @escaping @Sendable () -> Date = Date.init, leeway: TimeInterval = 30, timeout: Double? = nil)
  func token(scopes: [String]) async throws -> String; func invalidate(_ rejected: String?); nonisolated var managed: Bool }
```
規則は M1 Task 15 / M2 Task 4 と同じ。single-flight は actor 内の `[String: Task<TokenSet, any Error>]` で行い、取得 Task は呼び出し側から切り離す（1 つの呼び出しのキャンセルが共有取得を止めない。キャンセルされた呼び出しは取得完了後に `CancellationError`）。

- [ ] **Step 1:** 失敗するテストを書く: selector の 4 パターン、bearer の非同期プロバイダ、basic の UTF-8（`user:päss` → `dXNlcjpww6Rzcw==`）、apiKey の header / query / cookie、送信前の `AuthError`（transport に届かない）、再入時の新トークン適用、管理トークンの 401 で 1 回再送、`customAuth` が未知スキームを満たす、client credentials の Basic 認証、期限 30 秒前までのキャッシュ、5 並行で 1 回、キャンセルした待機者だけが失敗、refresh grant のローテーションと `onRefreshed`、相対 tokenUrl の解決、token endpoint の失敗で `AuthError`。
- [ ] **Step 2–4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(runtime-swift): add auth application and OAuth2 token manager`。

## Task 4: Swift runtime — 標準 middleware

**Files:**
- Create: `runtimes/swift/src/StandardMiddleware.swift`
- Test: `runtimes/swift/tests/StandardMiddlewareTests.swift`

**Interfaces（Produces）:**
```swift
public struct LoggingMiddleware: Middleware { init(includeHeaders: Bool = false, redactHeaders: [String] = [], redactQuery: [String] = [], log: @escaping @Sendable (String) -> Void = { print($0) }) }
public struct UserAgentMiddleware: Middleware { init(_ value: String) }
public struct RetryOptions: Sendable { maxAttempts = 3; baseDelay = 0.2; maxDelay = 5; maxRetryAfter = 60; statuses = [408,429,500,502,503,504]; methods = [.get,.head,.options,.put,.delete]; retryOnNetworkError = true; sleep; random; now }
public struct RetryMiddleware: Middleware { init(_ options: RetryOptions = RetryOptions()) }
public struct Retry401Middleware: Middleware { init(onUnauthorized: @escaping @Sendable (CallContext, ApiResponse) async throws -> Bool) }
```
挙動は M1 Task 16 / M2 Task 5 と同じ（ログ行は `→ {METHOD} {マスク済み URL}`、`includeHeaders` で `  {name}: {value}`、最後に `← {status} ({ms}ms)`）。

- [ ] **Step 1–4:** テスト（503 + `Retry-After`、POST は再送しない、非 replayable は再送しない、`maxAttempts` で停止、通信エラーの再送、タイムアウトは再送しない、jitter の範囲、retry401 で新トークン、logging のマスク、userAgent）→ 実装 → ランタイム全テスト PASS。
- [ ] **Step 5:** Commit `feat(runtime-swift): add logging, user-agent, retry and retry401 middleware`。

## Task 5: Swift plugin — 名前・型対応・モデル

**Files:**
- Create: `packages/archon/src/plugins/swift/{index,reserved,names,types,emit,models,runtime}.ts`
- Modify: `packages/archon/src/plugins.ts`
- Test: `packages/archon/test/plugins/swift/{helpers,names,types,models,runtime}.test.ts`

**Interfaces（Produces）:**
```ts
interface SwiftPluginOptions {
  output: string;                       // 既定 'swift'
  moduleName: string | undefined;       // 既定: info.title の PascalCase（'Archon Edge Cases' → 'ArchonEdgeCases'）
  clientName: string;                   // 既定 'ApiClient'
  package: false | { name?: string } | undefined;   // Package.swift の name（既定 moduleName）
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
    // 既定 type PascalCase / method camelCase / property camelCase / file = 型名
  typeMappings: Record<string, string>; // 'string:uuid' / 'integer' 等 → Swift 型式
  hooks: { typeName?; methodName?: (op) => string | undefined; propertyName?: (name, ctx: { schema }) => string | undefined;
           fileName?: (typeName) => string | undefined; typeOverride?: (schema, ctx: { path }) => string | undefined };
  include?: string[]; exclude?: string[];
}
interface SwiftPluginAPI { symbols: {
  typeOf(schemaName: string): { name: string; module: string; file: string };
  operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string } } }
```
`irRequirements`: `{ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }`。
型対応（`hooks.typeOverride` → `typeMappings['kind:format']` → `typeMappings['kind']`）: string → `String`（`date-time` → `Date`、`date` → `CalendarDate`、`uuid` → `UUID`、`byte` → `Data`）、integer → `Int`（`int32` → `Int32`、`int64` → `Int64`）、number → `Double`（`float` → `Float`）、boolean → `Bool`、binary → `ApiFile`、unknown / null / tuple / 平坦化されなかった intersection → `JSONValue`、array → `[T]`、プロパティを持たない object → `[String: T]`（additionalProperties が無ければ `[String: JSONValue]`）、const → 値の型。object（プロパティあり）/ enum / union だけが型を宣言し、他の named schema は展開する（循環すれば `JSONValue`）。nullable または optional なら `T?`。
モデル出力（1 型 1 ファイル `Sources/<Module>/Models/<Name>.swift`、先頭に生成ヘッダと `import Foundation`）:
- object → `public struct X: Codable, Hashable, Sendable`。`public var` プロパティ（値の循環に入るものは `Indirect` に格納し computed property で公開）、全プロパティを引数に取る `public init`（optional は `= nil`、const / 単一値 enum の必須プロパティは既定値）、`CodingKeys`（raw value がワイヤ名）、明示的な `init(from:)` / `encode(to:)`（必須は `decode` / `encode`、optional は `decodeIfPresent` / `encodeIfPresent`、必須 nullable は `decodeIfPresent` / `encode`（null を書く））。additionalProperties とプロパティの両方を持つなら `public var additionalProperties: [String: JSONValue]`（既知キー以外を保持し、書き出す）。description は `///`、deprecated は `@available(*, deprecated)`。
- enum → `public enum X: Codable, Hashable, Sendable, RawRepresentable, CaseIterable`。既知値の case、`unknown(Raw)`、`init(rawValue:)`（非 failable）、`rawValue`、`allCases`（既知値のみ）、`isKnown`、`==` / `hash(into:)` は rawValue で比較。case 名は値の camelCase（数字始まりは `_`、空は `empty`、キーワードはバッククォート、`unknown` / `rawValue` / `allCases` / `isKnown` / `init` / `self` と衝突すれば接尾辞）。
- union → `public indirect enum X: Codable, Hashable, Sendable`。バリアントごとに case（名前は型名の camelCase。`cat`, `string`, `catList` 等、衝突は接尾辞）+ `unknown(JSONValue)`。判別ありは判別値を読んで mapping のバリアントを decode、判別なしは宣言順に `try?` で試す（M2 と同じく、互いを含む判別なし union は展開して循環を断つ）。`encode(to:)` は保持している値をそのまま書く。
名前の予約: 型名はランタイムの型名、`ApiAuth`、`<clientName>`、サービス名、モジュール名、`<Module>Core`、`Swift` / `Foundation` / `FoundationNetworking`、宣言できない名前（大文字小文字無視で衝突回避、各型は自分のファイルを持つため）。プロパティ名は `hashValue`、`additionalProperties`、`init`、`self`、`Type` を避ける。生成コードが参照する標準型（`String`, `Int`, `Date`, `Data`, `UUID`, `Codable`, `Decoder`, `CodingKey`, `DecodingError` 等）は、同名のモデルがあるときだけ `Swift.` / `Foundation.` を付ける。

- [ ] **Step 1:** 失敗するテストを書く（names: 不正・衝突する名前の正規化、types: format と nullable、展開、循環時の `JSONValue`、typeMappings / typeOverride、models: required / optional / nullable と CodingKeys、自己参照（配列は直接、`parent: Node?` は `Indirect`）、enum の `unknown` と整数 enum の `_1`、判別あり / なしの union、文字列と object の union、deprecated、`Error` という名前のモデルがあるとき `Swift.Error` を修飾、runtime: ランタイムの読み込みと型名一覧）。
- [ ] **Step 2–4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(plugin-swift): emit Swift models, unions and enums`。

## Task 6: Swift plugin — サービス / ApiClient / ApiAuth / Package.swift / ランタイムのコピー

**Files:**
- Create: `packages/archon/src/plugins/swift/{services,client,package}.ts`
- Modify: `packages/archon/src/plugins/swift/index.ts`
- Test: `packages/archon/test/plugins/swift/{services,client}.test.ts`

**Interfaces（Produces、生成物の構造）:**
```
<outputDir>/
  Package.swift                          # package !== false のとき
  Sources/<Module>/<ClientName>.swift     # ApiClient
  Sources/<Module>/ApiAuth.swift
  Sources/<Module>/Exports.swift          # @_exported import <Module>Core
  Sources/<Module>/Models/*.swift
  Sources/<Module>/Services/<Group>Service.swift
  Sources/<Module>Core/*.swift            # runtimes/swift/src/*.swift のコピー
```
```swift
public struct EchoService: Sendable {
    let core: ApiClientCore
    init(core: ApiClientCore) { self.core = core }
    /// Echo path parameters in simple, label and matrix styles
    /// - Parameter simple: `simple`, not exploded: `a,b`
    public func echoPathStyles(simple: [String], label: [String], matrix: EchoPathStylesMatrix, options: RequestOptions? = nil) async throws -> Echo {
        try await echoPathStylesWithResponse(simple: simple, label: label, matrix: matrix, options: options).data
    }
    public func echoPathStylesWithResponse(simple: [String], …, options: RequestOptions? = nil) async throws -> ApiResult<Echo> {
        var values = RequestValues()
        try values.path("simple", simple)
        …
        return try await core.send(Self.echoPathStylesSpec, values, decoder: .json(Echo.self), errors: Self.echoPathStylesErrors, options: options)
    }
    static let echoPathStylesSpec = OperationSpec(…)
    static let echoPathStylesErrors = ErrorDecoders().json("401", Error.self)
}
```
- 引数順: path（テンプレート順）→ 必須 body（ラベル `body`）→ 必須 query / header / cookie → optional body → optional query / header / cookie → `options: RequestOptions? = nil`。名前は camelCase、キーワードはバッククォート、衝突は接尾辞（`options` / `values` / `body` を予約）。
- 成功型・エラー・body の扱いは M2 Task 7 と同じ（json → `.json(T.self)`、text → `.text`、binary → `.binary`（`Data`）、content 無し → `ApiResult<Void>` と `Void`。body の json → `values.json(body)`、form → `values.form(body)`、multipart → `MultipartBody` を組み立ててファイル型のプロパティだけ `file` / `files`、text → `values.text(body)`、binary → `values.binary(body)`（`Data`）。form / multipart の schema が object でなければ引数型を `JSONValue` / `MultipartBody` にする。GET / HEAD の body は warn `request-body-ignored`）。
- include / exclude を通らない操作は出力しない。deprecated の操作は `@available(*, deprecated)`。
```swift
public final class ApiClient: Sendable {
    public static let defaultBaseUrl = "http://localhost:4010"
    public static let securitySchemes: [String: SecuritySchemeSpec] = […]     // http-other / mutualTLS は出さない
    public let core: ApiClientCore
    public let echo: EchoService …
    public convenience init(baseUrl: String = ApiClient.defaultBaseUrl, auth: ApiAuth? = nil, headers: ApiHeaders = [:], timeout: Double? = nil,
                            middleware: [any Middleware] = [], transport: (any HTTPTransport)? = nil, customAuth: CustomAuth? = nil)
    public init(options: ClientOptions)
    public var options: ClientOptions { get set }
    @discardableResult public func use(_ middleware: any Middleware) -> ApiClient
}
public struct ApiAuth: AuthConfig { public var bearerAuth: TokenValue?; public var basicAuth: BasicValue?; public var oauth2: OAuth2Value? …; public init(…= nil); public func value(for scheme: String) -> AuthValue? }
```
Package.swift（`package` から）: `name` は `package.name ?? moduleName`。

- [ ] **Step 1:** 失敗するテストを書く: 引数順、`id` の衝突、キーワード引数、`options` という名前のパラメータ、OperationSpec の styles / security / responses、最小 2xx、content 無しの `ApiResult<Void>`、エラーデコーダ、multipart の `file` / `files`、object でない form、include / exclude、`methodName` フックと `naming.method`、`defaultBaseUrl` の server variable 展開、`securitySchemes`、スキーム種別ごとの `ApiAuth`、サービス名と予約メンバー、Package.swift と `package: false`、`Exports.swift`、ランタイムのコピー、symbols。
- [ ] **Step 2–4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(plugin-swift): emit services, client, auth, Package.swift and vendored runtime`。

## Task 7: スナップショットとコンパイルテスト

**Files:**
- Modify: `packages/archon/test/e2e-generate/snapshot.test.ts`
- Create: `packages/archon/test/e2e-generate/swift-compile.test.ts`, `packages/archon/test/e2e-generate/__snapshots__/swift/**`

- [ ] **Step 1:** snapshot: petstore と edge-cases を `swift({ output: '.' })` で生成し、info 以外の診断が無いこと、`Sources/*Core/` 以外の全ファイルをスナップショットと比較する。compile（`swift` が PATH に無ければ skip、逐次、各 300 秒）: 生成先で `swift build -Xswiftc -warnings-as-errors` が終了コード 0。ケース: stress（`Error` / `Date` / `Data` / `Type` / `ApiRequest` という名前のモデル、`A↔B` と `Node.parent` の循環、互いを含む union、キーワードのプロパティ・enum 値）、petstore、edge-cases、natsuneko（既定）、natsuneko（`moduleName: 'NatsunekoApi'`, `clientName: 'NatsunekoClient'`, `typeMappings: { 'string:date-time': 'String' }`）、natsuneko（`filters.schemas.include: ['/^Album/']`）。
- [ ] **Step 2:** 通るまでプラグインを直す。
- [ ] **Step 3:** スナップショットを目視確認し、`pnpm test` 全体が PASS。
- [ ] **Step 4:** Commit `test: add snapshot and swift build tests for Swift output`。

## Task 8: Swift E2E

**Files:**
- Create: `e2e/swift/{package.json,Package.swift,scripts/run.mjs,scripts/generate.mjs,Tests/ArchonE2ETests/*.swift}`
- Modify: root `package.json`（`test:e2e:swift`）、`.gitignore`

`run.mjs` は生成（`swift({ output: 'EdgeCases', moduleName: 'ArchonEdgeCases' })` を `e2e/swift/generated` へ）→ `startMockServer()` → `ARCHON_E2E_BASE_URL` / `ARCHON_E2E_SECONDARY_URL` を付けて `swift test --package-path e2e/swift` → サーバを閉じ、終了コードで終了する。全テストは `.serialized` のルート suite の下に置く（`/__stats` を前後比較するため）。

シナリオ（TS / C# と同じ。期待値も同じで、差分は「意図的な差分」の URL エンコードと空 JSON、型の違いだけ）:
- [ ] **Step 1:** テストを書く。Params（全 path style、予約文字と非 ASCII、全 query style を `&` 連結した文字列と完全一致（`piped=1%7C2`、`filter%5Bstatus%5D=active&filter%5BminAge%5D=3`）、未設定の省略、header 配列と cookie）、Bodies（JSON、form、multipart、binary、text、再帰ツリー）、Responses（text、binary 256 バイト、204、空 JSON は `DecodeError`）、Unions（shapes の `.circle` / `.square` / `.unknown`（`side == 3`）、pets、enums、dates）、Auth（bearer / basic / apiKey 3 種、誤った bearer は `ApiError` 401 で `body as? Error`、未設定は `AuthError` でサーバに届かない、optional、AND、oauth2 の client credentials / refresh / 先回り更新 / 5 並行）、Middleware（retry、maxAttempts、retry401、logging のマスク、userAgent、登録順）、Errors（200 / 404 / 400 / 418 / 500）、Redirect（クロスオリジンで資格情報が落ちる）。
- [ ] **Step 2:** `pnpm test:e2e:swift` を通るまでランタイム / プラグインを直す（期待値は緩めない）。
- [ ] **Step 3:** `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:e2e:csharp`、`swift test --package-path runtimes/swift` がすべて通る。
- [ ] **Step 4:** Commit `test: add Swift end-to-end suite against the mock server`。

## Task 9: CI・README・例

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `examples/natsuneko/archon.config.ts`

- [ ] **Step 1:** CI に `runtime-swift`（ubuntu、`swift test --package-path runtimes/swift`）と `e2e-swift`（ubuntu、`pnpm test:e2e:swift`）を追加し、`test` ジョブに Swift ツールチェーンを入れて compile テストを走らせ、`ci-ok` の `needs` と build ジョブの tarball 検査（`runtimes/swift/**` を含み、`.build` / `Package.swift` を含まない）を更新する。
- [ ] **Step 2:** `examples/natsuneko/archon.config.ts` に `swift({ output: 'swift', moduleName: 'NatsunekoApi' })` を追加する。
- [ ] **Step 3:** README に Swift の節（生成物の構成、SwiftPM での取り込み、`ApiClient(baseUrl:auth:)`、`client.catalyst.getX(...)` と `WithResponse`、エラーの種類、middleware、OAuth2、独自 transport / URLSession の条件、enum と union の使い方、意図的な差分）を追加し、ロードマップの M4 を完了にする。
- [ ] **Step 4:** Commit `docs: document the Swift plugin and runtime` / `ci: run the Swift runtime, compile and E2E tests`。
