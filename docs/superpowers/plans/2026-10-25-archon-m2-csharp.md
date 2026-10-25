# Archon M2（C#）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** C#（.NET 10）言語プラグインと、外部依存ゼロ（BCL のみ）の手書き C# ランタイムを実装する。`edge-cases.yaml` と `natsuneko.json` から生成した C# SDK が `dotnet build` を警告ゼロで通り、TypeScript と同じ E2E シナリオがモックサーバに対して通ることを完了条件とする。

**Architecture:** `runtimes/csharp/src` に SDK スタイルのランタイムプロジェクト（namespace `Archon.Runtime`）を置き、生成時に出力先 `Core/` へ namespace を `<Namespace>.Core` に書き換えてコピーする。C# プラグイン（`packages/archon/src/plugins/csharp`）は inline の object / enum / union を巻き上げた IR から、モデル（`Models/*.cs`）、タグ別サービス（`Services/*.cs`）、`ApiClient` / `ApiAuth`、System.Text.Json の source generation context（`ApiJsonContext.cs`）、`.csproj`（net10.0）を出力する。E2E は既存の `e2e/mock-server` を Node スクリプトで起動し、生成 SDK を参照する xUnit プロジェクトを `dotnet test` で実行する。

**Tech Stack:** .NET SDK 10.0（`net10.0`, C# 14）, System.Text.Json source generation, xUnit 2.9.3 + Microsoft.NET.Test.Sdk 17.12.0 + xunit.runner.visualstudio（テストプロジェクトのみ）, 既存の Node 24 / pnpm 10 / vitest ^3.2 / jiti ^2

**Spec:** `docs/superpowers/specs/2026-10-25-archon-design.md`（特に §6 生成 SDK 共通仕様、§7 C# 列、§8 認証、§10 テスト戦略）。M1 の構成と規約は `docs/superpowers/plans/2026-10-25-archon-m1-core-typescript.md` に従う。

## Global Constraints

- 生成 C# SDK とランタイムの依存は BCL のみ（`PackageReference` なし）。リフレクションベースの JSON 直列化は使わず、System.Text.Json source generation（`JsonTypeInfo<T>`）だけを使う（AOT / トリミング対応）。
- 生成 `.csproj`: `TargetFramework net10.0`、`Nullable enable`、`ImplicitUsings disable`、`LangVersion latest`、`IsAotCompatible true`。生成コードは `dotnet build -warnaserror` で警告ゼロ。
- nullable reference types 有効、必須プロパティは C# `required` メンバー、全公開非同期メソッドの最後の引数は `CancellationToken cancellationToken = default`（spec §7）。
- 型対応（spec §7 C# 列）: `date-time` → `DateTimeOffset`、`int64` → `long`、`uuid` → `Guid`、`uri` → `string`、nullable / optional → `T?`。
- 判別あり union → `[JsonPolymorphic]` 基底クラス、判別なし union → 自前 `JsonConverter`（バリアントを順に試行）、enum → 未知値を保持する型 + converter（spec §7、§6.6）。
- 予約語は `@` プレフィックス（spec §7）。
- API 形状は `client.<Group>.<Method>Async(...)`、戻り値は成功ボディ、非 2xx は `ApiException<T>`（spec §7）。
- Middleware は `IApiMiddleware { Task<ApiResponse> InvokeAsync(ApiRequest, ApiNext, CallContext, CancellationToken) }`（spec §6.2）。登録順に外側から実行し、認証適用は最内側（transport 直前）。
- 標準 middleware: logging（`Authorization` / `Cookie` / `Proxy-Authorization` / apiKey ヘッダ・クエリをマスク）、userAgent、retry（指数バックオフ + equal jitter、冪等メソッドのみ、429 / 503 は `Retry-After` を尊重）、retry401（コールバックが true なら 1 回だけ再送）。既定値は TS と同一（M1 Task 16）。
- 認証: OR-of-AND を先頭から評価、`{}` は他を満たせないときだけ匿名送信、必須認証が満たせなければ送信前に `ApiAuthException`。OAuth2 は期限 30 秒前に先回り更新、更新は single-flight、管理トークンで 401 を受けたら 1 回だけ強制更新して再送（spec §8）。
- `baseUrl` と異なるオリジンへのリダイレクトでは `Authorization` / `Cookie` / apiKey ヘッダ・クエリを送らない（spec §8.5）。
- リクエストは再送可能（body はバッファ済み）。ストリーム body は `Replayable = false` で、retry 系は再送しない（spec §6.2）。
- パラメータ直列化・エンコード結果は TS ランタイムとバイト単位で一致させる（`encodeURIComponent` / `URLSearchParams` と同じ文字集合。M1 Task 13 の表）。
- requestBody の media type 優先順は json > multipart > form > text > binary（IR で並べ替え済み、`contents[0]` を採用）。
- 生成物の各ファイル先頭には生成ヘッダ（`// ` コメント、`output.header` で上書き可）を付与する。

## Spec からの M2 における意図的な差分

- **enum は C# `enum` ではなく「拡張可能 enum」構造体**（`readonly partial struct Status : IEquatable<Status>`、`Value` に生の値、既知値は static プロパティ、`IsKnown`）にする。C# `enum` では未知値の生の値を保持できず、再送時に値が壊れる（§6.6 の `Unknown(raw)` を満たせない）ため。Azure SDK と同じ形。
- **判別あり union の未知バリアント**: `[JsonPolymorphic(IgnoreUnrecognizedTypeDiscriminators = true)]` は未知の判別値を基底型にフォールバックするが、判別プロパティ自体はメタデータとして消費され保持できない（STJ の制約。プロトタイプで確認済み）。そこで基底クラスを非 abstract にし、`[JsonExtensionData] AdditionalProperties` に残りのプロパティを保持する。判別値そのものは失われる。`[JsonPolymorphic]` の適用条件（Task 6）を満たさない判別あり union は、判別なしと同じラッパー + converter 方式（判別値でバリアントを選び、未知は生 JSON を保持）にする。
- **判別プロパティはバリアントのクラスから除く**（STJ が判別プロパティ名と同名のプロパティを拒否するため）。バリアント型を単独で直列化した場合は判別プロパティが出力されない。
- **`throwOnError` は無い**: C# は常に例外（spec §7「戻り値 + `ApiException<T>`」）。ステータスやヘッダが必要な呼び出し側のために、各操作に `<Method>WithResponseAsync`（`ApiResult<T>` を返す）を併せて生成する。
- **キャンセル**: 呼び出し側の `CancellationToken` によるキャンセルは .NET の慣習どおり `OperationCanceledException` をそのまま投げる。タイムアウトと通信失敗は `ApiTransportException`。
- **省略可能プロパティの null は書かない**（`JsonIgnoreCondition.WhenWritingNull`）。「未設定」と「null」の区別はスコープ外（spec §1.5）なので、optional + nullable の `null` は送信されない。
- **応答が空の JSON**（`204` 宣言 / 空 body）は `default`（参照型なら `null`）を返す。戻り値型は schema の nullable に従う（空 body の可能性は型に出さない）。
- **整数**: format 無しの `integer` は `int`（`int32` も `int`、`int64` は `long`）。`typeMappings['integer']` で上書きできる。`date` は `DateOnly`、`time` は `TimeOnly`、`byte` は `byte[]`（base64）。
- **コアの追加**: C# は union にも名前が要るので、hoist に `unions` を追加し、`IRRequirements.hoistInlineUnions` で要求できるようにする（Task 1）。TS プラグインは要求しないので出力は変わらない。

## Review Focus

- **C# 識別子として不正・衝突する名前**（プロパティ `x-foo` / `2fa` / `class` / `foo_bar` と `fooBar`、クラスと同名のプロパティ `Echo.echo`、schema 名 `Foo.Bar` / `1Thing` / ランタイムの型名 `ApiRequest`、パラメータ `id` が path と query の両方）→ 正規化された PascalCase / camelCase、先頭数字は `_`、キーワードは `@`、衝突は接尾辞、ワイヤ名は `[JsonPropertyName]` で保持される。→ Task 6、Task 7 にテストを追加。
- **自己参照 / 相互参照する schema と union**（`Node.children: Node[]`、union のバリアントが union を参照）→ モデル出力と JSON context の型登録が無限ループせず、`dotnet build` が通る。→ Task 6 にテスト、Task 8 の natsuneko compile で確認。
- **path / query の値に予約文字・非 ASCII**（`a/b?c#d e`、`日本`、`|`、`[`）→ TS と同じ percent-encoding で 1 セグメントに収まり、`System.Uri` の正規化で書き換わらない（`|` が `%7C` にならない）。→ Task 2、Task 3、Task 9 にテストを追加。
- **同時リクエストと OAuth2 更新**（コールドクライアントで 5 並行、呼び出し側の 1 つがキャンセル）→ トークン取得は 1 回、キャンセルした呼び出しだけが `OperationCanceledException` になり、他は成功する。→ Task 4 にテストを追加。
- **ユーザーが渡した `HttpClient` が自動リダイレクトする / Cookie コンテナを使う**→ 自動リダイレクトはランタイムが関与できないので、`ClientOptions.HttpClient` の XML doc に `AllowAutoRedirect = false` / `UseCookies = false` が必要と明記し、既定 HttpClient はその設定で作る。手動リダイレクトはランタイムが行う。→ Task 3 にテストを追加。

---

## File Structure

```
packages/archon/
  src/ir/types.ts                       # （済）IRParameter.description
  src/passes/all-of.ts                  # （済）祖先のパス単位追跡
  src/passes/hoist.ts                   # Task 1: unions オプション
  src/passes/index.ts                   # Task 1: runPluginPasses が hoistInlineUnions を受ける
  src/plugin/types.ts                   # Task 1: IRRequirements.hoistInlineUnions
  src/plugin/runtime.ts                 # Task 1: resolveRuntimeDir（言語共通に移動）
  src/plugins/typescript/runtime.ts     # Task 1: resolveRuntimeDir を plugin/runtime.ts から再 export
  scripts/copy-runtimes.mjs             # Task 1: .csproj / bin / obj を除外
  src/plugins.ts                        # Task 6: csharp を export
  src/plugins/csharp/
    index.ts        # definePlugin 本体・オプション・symbols API
    reserved.ts     # C# キーワード、予約メンバー名
    names.ts        # 型名・メンバー名・パラメータ名の決定（UniqueNamer）
    types.ts        # IRSchema → C# 型（値型かどうか、JSON context 登録キー）
    models.ts       # Models/*.cs（class / 拡張 enum / polymorphic 基底 / ラッパー union + converter）
    json-context.ts # ApiJsonContext.cs
    services.ts     # Services/*.cs（操作 spec、メソッド、エラーデコーダ）
    client.ts       # ApiClient.cs（ApiClient, ApiClientOptions）、ApiAuth.cs
    project.ts      # <Name>.csproj
    runtime.ts      # ランタイムのコピーと namespace 書き換え
  test/passes/hoist.test.ts             # Task 1 に追加
  test/plugins/csharp/{helpers,names,types,models,services,client,runtime}.test.ts
  test/e2e-generate/snapshot.test.ts    # Task 8: C# を追加
  test/e2e-generate/csharp-compile.test.ts  # Task 8
  test/e2e-generate/__snapshots__/csharp/{petstore,edge-cases}/**

runtimes/csharp/
  src/Archon.Runtime.csproj
  src/{Specs,ApiHeaders,ApiRequest,ApiResponse,ApiResult,Errors,PercentEncoding,ParameterSerializer,
       RequestValues,ApiBody,ApiFile,ResponseDecoder,ErrorDecoder,Middleware,Transport,ClientOptions,
       ApiClientCore,Auth,OAuth2TokenManager,StandardMiddleware}.cs
  tests/Archon.Runtime.Tests/Archon.Runtime.Tests.csproj
  tests/Archon.Runtime.Tests/*.cs        # xUnit。ローカル HTTP は TcpListener 製の TestServer

e2e/csharp/
  package.json                          # @natsuneko-laboratory/archon-e2e-csharp（private）
  scripts/run.mjs                       # モック起動 → 生成 → dotnet test → 終了
  scripts/generate.mjs                  # 生成のみ（jiti 経由で archon の src を使う）
  tests/Archon.E2E.Tests.csproj         # generated/EdgeCases/*.csproj を ProjectReference
  tests/{Support,Params,Bodies,Responses,Unions,Auth,Middleware,Errors,Redirect}Tests.cs
```

ルート `package.json` に `"test:e2e:csharp": "pnpm -F @natsuneko-laboratory/archon-e2e-csharp test"`、`pnpm-workspace.yaml` に `e2e/*`（既存）、`.gitignore` に `e2e/csharp/generated/`, `**/bin/`, `**/obj/` を追加する。

### 依存してよいもの

`runtimes/csharp/src` と生成 SDK: BCL のみ。テストプロジェクト（`runtimes/csharp/tests`, `e2e/csharp/tests`）: `xunit` 2.9.3、`xunit.runner.visualstudio` 2.8.2、`Microsoft.NET.Test.Sdk` 17.12.0。`packages/archon` の依存は増やさない。

---

## Task 1: コア — union の巻き上げとランタイム探索の言語共通化

**Files:**
- Modify: `packages/archon/src/passes/hoist.ts`, `packages/archon/src/passes/index.ts`, `packages/archon/src/plugin/types.ts`, `packages/archon/src/plugin/host.ts`（runPluginPasses への受け渡し）, `packages/archon/src/plugins/typescript/runtime.ts`, `packages/archon/scripts/copy-runtimes.mjs`
- Create: `packages/archon/src/plugin/runtime.ts`
- Test: `packages/archon/test/passes/hoist.test.ts`, `packages/archon/test/passes/index.test.ts`, `packages/archon/test/plugins/typescript/runtime.test.ts`

**Interfaces:**
- Produces:
  - `type HoistOptions = { objects: boolean; enums: boolean; unions?: boolean; nameHook?: … }`。`unions: true` のとき、トップレベルでない `union` を named schema に移し `ref` に置き換える。名前は object と同じ規則（プロパティ → `{Parent}{Prop}`、配列要素 → `{…}Item`、body → `{Op}Body`、response → `{Op}Response{Status}`、パラメータ → `{Op}{Param}`）。バリアントの命名は巻き上げ後の union 名を親にする（`{Union}{Tag}` / `{Union}Variant{N}`）。nullable などの使用箇所メタは ref 側に残す。
  - `type IRRequirements = { hoistInlineObjects?: boolean; hoistInlineEnums?: boolean; hoistInlineUnions?: boolean }`、`runPluginPasses(ir, req: IRRequirements, nameHook?)`。
  - `resolveRuntimeDir(language: string, opts?: { marker?: string; fromUrl?: string }): string`（`plugin/runtime.ts`。marker 既定 `'index.ts'`。探索規則は M1 と同じ）。`plugins/typescript/runtime.ts` は同名で再 export する（既存 import を壊さない）。
  - copy-runtimes: `runtimes/<lang>/src` を、`*.test.ts`、`*.csproj`、`bin/`、`obj/` を除いてコピーする。

- [ ] **Step 1:** 失敗するテストを書く。
  - hoist: `hoists inline unions with Parent+Prop names when unions=true`: `Holder.properties.pet = union[ref Cat, object{x}]`（nullable）→ `Holder.pet` が `{kind:'ref', name:'HolderPet', nullable:true}`、`schemas.get('HolderPet')` が union で `nullable:false`、inline バリアントが `HolderPetVariant2`。
  - hoist: `names discriminated variants under the hoisted union name`: inline の判別あり union（`kind: circle` の inline object）が `HolderShape` / `HolderShapeCircle` になり、mapping の `''` が `HolderShapeCircle` で埋まる。
  - hoist: `hoists response unions as {Op}Response{Status}`、`leaves unions inline when unions is not set`（既存 TS の挙動を固定）。
  - index: `runPluginPasses passes hoistInlineUnions through`。
  - runtime: `resolveRuntimeDir finds the csharp runtime by marker`（marker `'ApiClientCore.cs'`。Task 2 より前に走らせるため、テスト内で一時ディレクトリに `runtimes/csharp/src/ApiClientCore.cs` を作り `fromUrl` を偽装する）。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/passes packages/archon/test/plugins/typescript/runtime.test.ts` → FAIL。
- [ ] **Step 3:** 実装する。`shouldHoist` に `opts.unions && s.kind === 'union'` を加える（トップレベルは従来どおり巻き上げない）。
- [ ] **Step 4:** 同コマンド → PASS。`pnpm test` で TS のスナップショットが変わらないことを確認する。
- [ ] **Step 5:** Commit `feat(core): hoist inline unions on request and share runtime lookup`。

## Task 2: C# runtime — scaffold / spec 型 / エラー / パラメータ直列化

**Files:**
- Create: `runtimes/csharp/src/Archon.Runtime.csproj`, `runtimes/csharp/src/{Specs,ApiHeaders,Errors,PercentEncoding,ParameterSerializer,RequestValues}.cs`, `runtimes/csharp/tests/Archon.Runtime.Tests/{Archon.Runtime.Tests.csproj,ParameterSerializerTests.cs,ErrorsTests.cs}`
- Modify: `.gitignore`

**Interfaces:**
- Produces（以降の runtime タスクと C# プラグインが使う。すべて `namespace Archon.Runtime;`、ファイルスコープ namespace、public）:
  ```csharp
  public enum ParamLocation { Path, Query, Header, Cookie }
  public enum ParamStyle { Simple, Label, Matrix, Form, SpaceDelimited, PipeDelimited, DeepObject }
  public sealed record ParamSpec(string Name, ParamLocation In, ParamStyle Style, bool Explode, bool AllowReserved = false);
  public enum BodyKind { Json, Form, Multipart, Text, Binary }
  public enum ResponseKind { Json, Text, Binary, Empty }
  public enum ApiKeyLocation { Header, Query, Cookie }
  public abstract record SecuritySchemeSpec {
    public sealed record HttpBearer : SecuritySchemeSpec; public sealed record HttpBasic : SecuritySchemeSpec;
    public sealed record ApiKey(ApiKeyLocation In, string Name) : SecuritySchemeSpec;
    public sealed record OAuth2(string? TokenUrl = null, string? RefreshUrl = null) : SecuritySchemeSpec;
    public sealed record OpenIdConnect : SecuritySchemeSpec; }
  public sealed record SecurityScheme(string Name, IReadOnlyList<string> Scopes);
  public sealed record SecurityRequirement(IReadOnlyList<SecurityScheme> Schemes);   // Schemes 空 = 任意認証
  public sealed record OperationSpec(string OperationName, HttpMethod Method, string Path, IReadOnlyList<string> Tags,
    IReadOnlyList<SecurityRequirement> Security, IReadOnlyList<ParamSpec> Params, BodyKind? Body, string? BodyMediaType,
    IReadOnlyDictionary<string, ResponseKind> Responses);                           // キー '200' | '2XX' | 'default'
  public sealed class ApiHeaders : IEnumerable<KeyValuePair<string, string>> {      // 大文字小文字無視、挿入順、1 名 1 値
    void Set(string name, string value); string? Get(string name); bool Contains(string name); bool Remove(string name); int Count { get; } }
  public class ApiException : Exception { int StatusCode; ApiHeaders Headers; string? RawBody; Uri? Url; }
  public sealed class ApiException<TError> : ApiException { TError Body; }
  public sealed class ApiTransportException : Exception { bool TimedOut; }
  public sealed class ApiDecodeException : Exception { int StatusCode; string RawBody; }
  public sealed class ApiAuthException : Exception { IReadOnlyList<string> Schemes; }
  internal static class PercentEncoding { string Component(string s); string Reserved(string s); string Form(string s); }
  public sealed class RequestValues {                                               // 生成コードが値を渡す
    RequestValues Path<T>(string name, T value, JsonTypeInfo<T> info);   // Query / Header / Cookie も同形
    JsonElement? Get(ParamLocation location, string name); }
  internal static class ParameterSerializer {
    string SerializePath(string template, IReadOnlyList<ParamSpec> specs, RequestValues values);
    string SerializeQuery(IReadOnlyList<ParamSpec> specs, RequestValues values);       // '?' なし、空なら ''
    string? SerializeHeader(ParamSpec spec, JsonElement value);
    string? SerializeCookie(IReadOnlyList<ParamSpec> specs, RequestValues values); }   // 'a=1; b=2'
  ```
  値はすべて `JsonSerializer.SerializeToElement(value, info)` で `JsonElement` にしてから直列化する（AOT 安全で、オブジェクトのキー順と enum の生の値をそのまま使える）。`Null` は出力しない。String は `GetString()`、Number は `GetRawText()`、True / False は `true` / `false`、Array は要素、Object はプロパティ（宣言順）。
  エンコード: `Component` は `encodeURIComponent` と同じ（`A–Z a–z 0–9 - _ . ! ~ * ' ( )` 以外を UTF-8 の `%XX` 大文字に）。`Reserved` はさらに `: / ? # [ ] @ $ & + , ; =` を戻す（query の allowReserved のみ）。`Form` は `URLSearchParams` と同じ（英数字と `* - . _` 以外を `%XX`、空白は `+`）。path の値が空・`.`・`..` のセグメントになる場合と header 値の CR / LF は `ArgumentException`。必須 path パラメータが無い場合も `ArgumentException`。
  `Archon.Runtime.csproj`: `net10.0`, `Nullable enable`, `ImplicitUsings disable`, `IsAotCompatible true`, `TreatWarningsAsErrors true`, `InternalsVisibleTo Archon.Runtime.Tests`。

- [ ] **Step 1:** 失敗するテストを書く。`ParameterSerializerTests` は M1 Task 13 の表（matrix / label / simple / form × explode、spaceDelimited / pipeDelimited / deepObject、値 `blue` / `[blue,black,brown]` / `{R:100,G:200,B:150}`）を `[Theory]` で全行そのまま検証する。追加:
  - `PercentEncodesReservedCharsInPathValues`: `/files/{name}` + `a/b?c#d e` → `/files/a%2Fb%3Fc%23d%20e`、`日本` → `%E6%97%A5%E6%9C%AC`（Review Focus）。
  - `AllowReservedKeepsReservedCharsInQuery`: `a/b?c:d` → `reserved=a/b?c:d`。`KeepsEncodeUriComponentSafeChars`: `!'()*~` はそのまま。
  - `SkipsNullValues`、`SerializesEnumStructAndDateTimeOffsetViaJson`（`DateTimeOffset` は STJ の ISO 文字列）、`SerializeCookieJoinsWithSemicolonSpace`、`RejectsDotSegmentPathValue`、`RejectsCrLfInHeader`。
  - `FormEncodingMatchesUrlSearchParams`: `a b&c` → `a+b%26c`、`*-._` はそのまま。
  - errors: `ApiExceptionOfTExposesStatusBodyAndRaw`。
- [ ] **Step 2:** `dotnet test runtimes/csharp/tests/Archon.Runtime.Tests` → ビルドエラー（型未定義）。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS（警告ゼロ）。
- [ ] **Step 5:** Commit `feat(runtime-cs): add spec types, errors and parameter serialization`。

## Task 3: C# runtime — body / transport / client core / middleware chain

**Files:**
- Create: `runtimes/csharp/src/{ApiRequest,ApiResponse,ApiResult,ApiBody,ApiFile,ResponseDecoder,ErrorDecoder,Middleware,Transport,ClientOptions,ApiClientCore,Auth}.cs`（`Auth.cs` はこのタスクでは何もしない `AuthMiddleware` スタブ）
- Test: `runtimes/csharp/tests/Archon.Runtime.Tests/{TestServer,BodyTests,TransportTests,ClientCoreTests}.cs`

**Interfaces:**
- Consumes: Task 2 の型。
- Produces:
  ```csharp
  public sealed class ApiRequest { HttpMethod Method {get;set;} Uri Url {get;set;} ApiHeaders Headers {get;} ApiBody? Body {get;set;}
    bool Replayable { get; }                                         // Body?.Replayable ?? true
    void SetQueryParameter(string name, string value); }             // 生の query を編集（他パラメータのバイトを保つ）
  public static class ApiUrl { Uri Create(string absolute); }        // UriCreationOptions.DangerousDisablePathAndQueryCanonicalization
  public sealed class ApiResponse : IDisposable { int StatusCode; ApiHeaders Headers; Uri Url; HttpResponseMessage Message; }
  public class ApiResult { int StatusCode; ApiHeaders Headers; Uri Url; }
  public sealed class ApiResult<T> : ApiResult { T Data; }
  public abstract class ApiBody { bool Replayable; string? ContentType; HttpContent CreateContent(); }
  public sealed class BytesBody(byte[] bytes, string? contentType) : ApiBody;
  public sealed class StreamBody(Stream stream, string? contentType) : ApiBody;          // Replayable = false
  public sealed class FormBody : ApiBody { static FormBody FromJson(JsonElement obj); void Add(string name, string value); }
  public sealed class MultipartBody : ApiBody { static MultipartBody FromJson(JsonElement obj);
    MultipartBody AddText(string name, string value); MultipartBody AddFile(string name, ApiFile? file); MultipartBody AddFiles(string name, IEnumerable<ApiFile>? files); }
  [JsonConverter(typeof(ApiFileJsonConverter))]                     // JSON 内では base64 文字列（Stream は書けない）
  public sealed class ApiFile { ApiFile(byte[] content, string? fileName = null, string? contentType = null); ApiFile(Stream content, string? fileName = null, string? contentType = null); }
  public abstract class ResponseDecoder<T> { }  public static class ResponseDecoder {
    ResponseDecoder<T> Json<T>(JsonTypeInfo<T> info); ResponseDecoder<string> Text { get; } ResponseDecoder<byte[]> Binary { get; } }
  public sealed class ErrorDecoders { ErrorDecoders(); ErrorDecoders Json<T>(string status, JsonTypeInfo<T> info); ErrorDecoders Text(string status); static ErrorDecoders None { get; } }
  public delegate Task<ApiResponse> ApiNext(ApiRequest request, CancellationToken cancellationToken);
  public interface IApiMiddleware { Task<ApiResponse> InvokeAsync(ApiRequest request, ApiNext next, CallContext context, CancellationToken cancellationToken); }
  public static class ApiMiddleware { IApiMiddleware Create(Func<ApiRequest, ApiNext, CallContext, CancellationToken, Task<ApiResponse>> fn); }
  public sealed class CallContext { string OperationName; HttpMethod Method; string PathTemplate; IReadOnlyList<string> Tags;
    IReadOnlyList<SecurityRequirement> Security; int Attempt {get;set;} IReadOnlySet<string> RedactHeaders; IReadOnlySet<string> RedactQuery;
    IDictionary<string, object?> Extensions; }
  public interface IAuthConfig { object? Get(string scheme); }      // 生成 ApiAuth が実装（Task 4 の値型を返す）
  public abstract class ClientOptions { string BaseUrl {get;set;} IDictionary<string,string> Headers {get;} TimeSpan? Timeout {get;set;}
    List<IApiMiddleware> Middleware {get;} HttpClient? HttpClient {get;set;}
    Func<ApiRequest, CallContext, CancellationToken, ValueTask>? CustomAuth {get;set;} abstract IAuthConfig? AuthConfig { get; } }
  public class ClientOptions<TAuth> : ClientOptions where TAuth : class, IAuthConfig { TAuth? Auth {get;set;} }
  public sealed class RequestOptions { IDictionary<string,string> Headers {get;} IDictionary<string, object?> Extensions {get;} string? BaseUrl {get;set;} }
  public sealed class ApiClientCore {
    ApiClientCore(ClientOptions options, IReadOnlyDictionary<string, SecuritySchemeSpec> securitySchemes);
    ClientOptions Options { get; } void Use(IApiMiddleware middleware);
    Task<ApiResult<T>> SendAsync<T>(OperationSpec op, RequestValues values, ResponseDecoder<T> decoder, ErrorDecoders errors, RequestOptions? options, CancellationToken cancellationToken);
    Task<ApiResult> SendAsync(OperationSpec op, RequestValues values, ErrorDecoders errors, RequestOptions? options, CancellationToken cancellationToken); }
  ```
  `RequestValues` に body 用の `JsonBody<T>(T, JsonTypeInfo<T>)`, `FormBody<T>(T, JsonTypeInfo<T>)`, `Body(ApiBody)`, `TextBody(string)`, `BinaryBody(ApiFile)` を追加する（Task 2 の型を拡張）。

挙動（M1 Task 14 と同じ規則を C# に写す。差分のみ記す）:
- URL: `baseUrl` 末尾の `/` と path 先頭の `/` を 1 つにまとめる。`ApiUrl.Create` で正規化を止める（`|` `%41` が書き換わらない）。相対 `baseUrl` は `ArgumentException`（ブラウザが無いので解決先が無い）。
- ヘッダ順: `Options.Headers` → header パラメータ → `RequestOptions.Headers` → Cookie → body の Content-Type（multipart は .NET が付ける）→ Accept（responses に Json があれば `application/json`、無ければ `*/*`）。
- チェーン: `[...Options.Middleware（スナップショット）, AuthMiddleware]`、terminal は `Transport.SendAsync`。`Use` は lock 下で末尾に追加する。`ctx.Attempt` は 1 から。
- 成功（2xx）: `decoder` で body を読む。Json は 204 / 205 / 304 / 空 body なら `default`、`JsonException` は `ApiDecodeException`（生テキスト保持）。非 2xx: body を文字列で読み、`errors` を `status` → `NXX` → `default` の順で引き、Json なら `ApiException<T>`（デコード失敗・空 body は非ジェネリック `ApiException`）を投げる。どちらの場合も `HttpResponseMessage` は読み終えたら破棄し、`ApiResult` にはヘッダ（response + content）と最終 URL をコピーする。
- body: Json は `SerializeToUtf8Bytes` + `Content-Type: <mediaType>`（charset を足さない）、Text は UTF-8 + `<mediaType>`、Form は `FormBody`（配列は繰り返しキー、object は JSON 文字列、null は省略）、Multipart は `MultipartFormDataContent` を送信のたびに作り直す（text 部と file 部の `Content-Disposition` は `name="…"`、`filename="…"` と引用符付きにし、`filename*` は付けない）、Binary は `ApiFile`（Stream は Replayable = false）。
- transport: 既定 HttpClient は static 共有の `SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, PooledConnectionLifetime = 5 分 }` + `Timeout = Infinite`。`HttpCompletionOption.ResponseHeadersRead`。タイムアウトは `CancellationTokenSource.CancelAfter` を呼び出し側トークンとリンクして実装し、タイムアウトなら `ApiTransportException(TimedOut = true)`、呼び出し側キャンセルは `OperationCanceledException` をそのまま、`HttpRequestException` / `IOException` は `ApiTransportException`。
- リダイレクト: 301 / 302 / 303 / 307 / 308 + `Location` を最大 20 回まで手動で追う。オリジンが変わったら `Authorization`、`Cookie`、apiKey ヘッダ、apiKey クエリを除去する。303（HEAD 以外）と POST の 301 / 302 は body なし GET に変え、`Content-*` を落とす。body を再送する必要があり Replayable でなければその 3xx を返す。`ApiResponse.Url` は最終 URL。

- [ ] **Step 1:** 失敗するテストを書く。`TestServer` は `TcpListener` で HTTP/1.1 を最小実装し、受け取った生のリクエスト行・ヘッダ・body を記録して、テストごとの応答を返す（2 つ起動すれば別オリジン）。
  - body: `EncodesJsonWithExactContentType`、`EncodesFormWithRepeatedArrayFields`（`name=a+b%26c&count=2&tags=x&tags=y`）、`EncodesMultipartWithQuotedNamesAndFilenames`、`StreamBodyIsNotReplayable`、`MultipartBodyCanBeSentTwice`。
  - client core:
    - `BuildsUrlPreservingBaseUrlPath`: `http://127.0.0.1:{port}/api/` + `/foo/{id}` + `id=1` → リクエスト行 `GET /api/foo/1?… HTTP/1.1`（Review Focus）。
    - `SendsPipeAndBracketsUnchanged`: query `piped=1|2&filter[a]=b` がリクエスト行にそのまま出る（Review Focus）。
    - `ReturnsTypedDataOn2xx`、`ThrowsTypedApiExceptionOn404WithParsedBody`、`ThrowsUntypedApiExceptionWhenErrorBodyIsNotJson`、`ReturnsDefaultFor204AndEmptyJson`、`ThrowsDecodeExceptionOnInvalidJson`。
    - `ThrowsTransportExceptionOnConnectionRefusedAndTimeout`（タイムアウトは `TimedOut == true`）、`CallerCancellationThrowsOperationCanceled`。
    - `RunsMiddlewareOuterToInnerWithAuthInnermost`: 記録順 `["mw1:before","mw2:before","auth","mw2:after","mw1:after"]`（AuthMiddleware スタブに記録フックを持たせる）。`UseAppendsMiddleware`。
  - transport: `ManualRedirectStripsCredentialsOnCrossOriginHop`（`X-API-Key` / `Authorization` / `Cookie` / `api_key` クエリが 2 つ目のオリジンに届かない）、`SameOriginRedirectKeepsHeaders`、`SeeOtherConvertsPostToGet`、`UserHttpClientIsUsed`（`ClientOptions.HttpClient` に渡した `HttpClient` の `DelegatingHandler` が呼ばれる。Review Focus）。
- [ ] **Step 2:** `dotnet test runtimes/csharp/tests/Archon.Runtime.Tests` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(runtime-cs): add client core, transport, body codec and middleware chain`。

## Task 4: C# runtime — 認証 / OAuth2 トークンマネージャ

**Files:**
- Create: `runtimes/csharp/src/OAuth2TokenManager.cs`
- Modify: `runtimes/csharp/src/Auth.cs`（スタブを置き換える）
- Test: `runtimes/csharp/tests/Archon.Runtime.Tests/{AuthTests,OAuth2TokenManagerTests,FakeTimeProvider}.cs`

**Interfaces:**
- Consumes: `ClientOptions`, `IAuthConfig`, `SecuritySchemeSpec`, `SecurityRequirement`, `IApiMiddleware`, `ApiAuthException`
- Produces:
  ```csharp
  public sealed class TokenValue { TokenValue(string token); TokenValue(Func<CancellationToken, ValueTask<string>> provider);
    static implicit operator TokenValue(string token); ValueTask<string> GetAsync(CancellationToken ct); }
  public sealed record BasicCredentials(string Username, string Password);
  public sealed class BasicValue { BasicValue(string username, string password); BasicValue(Func<CancellationToken, ValueTask<BasicCredentials>> provider); }
  public enum OAuth2ClientAuth { Basic, Post }
  public sealed class OAuth2ClientCredentials { required string ClientId; required string ClientSecret; IReadOnlyList<string>? Scopes; string? TokenUrl; OAuth2ClientAuth ClientAuth = Basic; }
  public sealed class OAuth2RefreshToken { required string RefreshToken; required string ClientId; string? ClientSecret; string? TokenUrl;
    OAuth2ClientAuth ClientAuth = Basic; Func<TokenSet, CancellationToken, ValueTask>? OnRefreshed; }
  public sealed class OAuth2Value { TokenValue? AccessToken; OAuth2ClientCredentials? ClientCredentials; OAuth2RefreshToken? RefreshToken; }
  public sealed record TokenSet(string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt, string? Scope);
  public abstract record Selection { sealed record Apply(SecurityRequirement Requirement); sealed record Anonymous; sealed record Missing(IReadOnlyList<string> Schemes); }
  public static class SecuritySelector { Selection Select(IReadOnlyList<SecurityRequirement> requirements, Func<string, bool> isConfigured); }
  public sealed class OAuth2TokenManager { OAuth2TokenManager(HttpClient http, OAuth2Value config, string? tokenUrl, Uri? baseUrl, string scheme, TimeProvider? time = null, TimeSpan? leeway = null);
    Task<string> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken ct); void Invalidate(string? rejectedToken = null); bool Managed { get; } }
  internal sealed class AuthMiddleware : IApiMiddleware { AuthMiddleware(ApiClientCore core); }
  ```
  規則は M1 Task 15 と同じ: selection、bearer / basic（UTF-8 → base64）/ apiKey（header / `SetQueryParameter` / Cookie に追記）/ oauth2・openIdConnect（`AccessToken` 優先、無ければ manager）、`CustomAuth` を最後に呼ぶ、securitySchemes に無いスキームは `CustomAuth` があれば設定済み扱い、`Missing` は送信前に `ApiAuthException`。manager はスキームごとに作り、`Options.AuthConfig` / `BaseUrl` の参照が変わったら作り直す。管理トークンで 401 かつ Replayable なら、その応答を破棄し `Invalidate(token)` して 1 回だけ再送する。
  `OAuth2TokenManager`: grant / clientAuth / `expires_in` / 30 秒 leeway / scope の合算とソート（キャッシュキーは refreshToken なら `''`、それ以外はソート済み scope の空白連結）/ refresh_token の差し替えと `OnRefreshed` / tokenUrl（config > spec、相対なら `baseUrl` で解決）/ 非 2xx・JSON 不正・`access_token` 無しは `ApiAuthException` — すべて TS と同じ。single-flight は lock 下の `Dictionary<string, Task<TokenSet>>` で行い、取得自体は `CancellationToken.None`（+ `Options.Timeout`）で実行し、各呼び出し側は `task.WaitAsync(ct)` で待つ（1 人のキャンセルが他を巻き込まない）。時刻は `TimeProvider`。

- [ ] **Step 1:** 失敗するテストを書く。
  - selector: `[]` → Anonymous、`[[bearer],[]]` で未設定 → Anonymous、`[[bearer]]` で未設定 → Missing `["bearer"]`、AND の一部だけ設定 → 次の代替へ。
  - auth: `AppliesBearerFromAsyncProvider`、`AppliesBasicWithUtf8`（`user:päss` → `dXNlcjpww6Rzcw==`）、`AppliesApiKeyInHeaderQueryCookie`、`ThrowsAuthExceptionBeforeSending`（TestServer に到達しない）、`ReappliesFreshTokenOnReentry`、`RetriesOnceOn401WithManagedToken`、`CustomAuthCoversUnknownScheme`。
  - oauth2: `FetchesClientCredentialsWithBasicClientAuth`、`CachesUntil30sBeforeExpiry`（FakeTimeProvider を進める）、`SingleFlightForConcurrentCalls`（5 並行で token endpoint 1 回）、`CancelledWaiterDoesNotCancelSharedFetch`（1 つを途中でキャンセル → その呼び出しだけ `OperationCanceledException`、残り 4 つは成功、発行 1 回。Review Focus）、`RefreshGrantRotatesTokenAndCallsOnRefreshed`、`ResolvesRelativeTokenUrlAgainstBaseUrl`、`AuthExceptionOnTokenEndpointFailure`。
- [ ] **Step 2:** `dotnet test runtimes/csharp/tests/Archon.Runtime.Tests` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(runtime-cs): add auth application and OAuth2 token manager`。

## Task 5: C# runtime — 標準 middleware

**Files:**
- Create: `runtimes/csharp/src/StandardMiddleware.cs`
- Test: `runtimes/csharp/tests/Archon.Runtime.Tests/StandardMiddlewareTests.cs`

**Interfaces:**
- Produces:
  ```csharp
  public sealed class LoggingOptions { Action<string> Log {get;init;} = Console.WriteLine; bool IncludeHeaders; IEnumerable<string>? RedactHeaders; IEnumerable<string>? RedactQuery; }
  public sealed class LoggingMiddleware(LoggingOptions? options = null) : IApiMiddleware;
  public sealed class UserAgentMiddleware(string value) : IApiMiddleware;
  public sealed class RetryOptions { int MaxAttempts = 3; TimeSpan BaseDelay = 200ms; TimeSpan MaxDelay = 5s; TimeSpan MaxRetryAfter = 60s;
    IReadOnlyCollection<int> Statuses = [408,429,500,502,503,504]; IReadOnlyCollection<HttpMethod> Methods = [GET,HEAD,OPTIONS,PUT,DELETE];
    bool RetryOnNetworkError = true; Func<TimeSpan, CancellationToken, Task>? Delay; Func<double>? Random; TimeProvider? Time; }
  public sealed class RetryMiddleware(RetryOptions? options = null) : IApiMiddleware;
  public sealed class Retry401Middleware(Func<CallContext, ApiResponse, CancellationToken, ValueTask<bool>> onUnauthorized) : IApiMiddleware;
  ```
  挙動は M1 Task 16 と同じ（equal jitter `min(MaxDelay, BaseDelay * 2^(attempt-1)) * (0.5 + Random()/2)`、429 / 503 の `Retry-After` 秒数・HTTP-date を `MaxRetryAfter` で上限、Replayable でなければ再送しない、再送ごとに `ctx.Attempt++`、捨てる応答は Dispose、タイムアウトの `ApiTransportException` は再送しない）。logging の行は `→ {METHOD} {マスク済み URL}`、`IncludeHeaders` のとき各ヘッダ `  {name}: {value}`、最後に `← {status} ({ms}ms)`。マスク対象は既定 `authorization` / `cookie` / `proxy-authorization` / `set-cookie` + `ctx.RedactHeaders` / `RedactQuery` + options（大文字小文字無視）、値は `***`。

- [ ] **Step 1:** 失敗するテストを書く: `Retries503WithRetryAfterSeconds`（Delay に 1 秒）、`DoesNotRetryPostByDefault`、`DoesNotRetryNonReplayable`、`StopsAfterMaxAttempts`、`RetriesNetworkErrors`、`EqualJitterBounds`、`Retry401RetriesOnceWithFreshAuth`（Task 4 の bearer provider と組み合わせて新トークン）、`LoggingMasksAuthorizationCookieAndApiKeyQuery`、`UserAgentSetsHeader`。
- [ ] **Step 2:** テスト実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** ランタイムの全テストが PASS。
- [ ] **Step 5:** Commit `feat(runtime-cs): add logging, user-agent, retry and retry401 middleware`。

## Task 6: C# plugin — 名前・型対応・モデル・JSON context

**Files:**
- Create: `packages/archon/src/plugins/csharp/{index,reserved,names,types,models,json-context,runtime}.ts`
- Modify: `packages/archon/src/plugins.ts`（`csharp` と型を export）
- Test: `packages/archon/test/plugins/csharp/{helpers,names,types,models,runtime}.test.ts`

**Interfaces:**
- Consumes: `definePlugin`, `CodeWriter`, `toCase`, `applyTemplate`, `UniqueNamer`, IR、Task 1 の `hoistInlineUnions`
- Produces:
  ```ts
  type NamingRule = { case?: NameCase; name?: string | ((name: string) => string) };   // TS と同じ型を再利用
  interface CSharpPluginOptions {
    output: string;                    // 既定 'csharp'
    namespace: string | undefined;     // 既定: info.title を '.' 区切りの各部分 PascalCase（'Archon Edge Cases' → 'ArchonEdgeCases'）
    clientName: string;                // 既定 'ApiClient'
    package: false | { name?: string; version?: string; description?: string; authors?: string; license?: string } | undefined;
    naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
      // 既定 type PascalCase / method { case: PascalCase, name: '{{name}}Async' } / property PascalCase / file preserve
    typeMappings: Record<string, string>;   // キー 'string:uuid' / 'integer' 等、値は C# 型式
    hooks: { typeName?; methodName?: (op) => string | undefined; propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
             fileName?: (name: string) => string | undefined; typeOverride?: (schema, ctx: { path }) => string | undefined };
    include?: string[]; exclude?: string[];
  }
  interface CSharpPluginAPI { symbols: {
    typeOf(schemaName: string): { name: string; namespace: string; file: string };
    operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string } } }
  const csharp: (options?: DeepPartial<CSharpPluginOptions>) => ArchonPlugin<CSharpPluginOptions, CSharpPluginAPI>;
  // names.ts
  type CsNames = { types: Map<string, string>; members(schemaName: string): Map<string, string> /* wire → C# */ };
  buildNames(ir: IRDocument, opts: CSharpPluginOptions, reserved: Iterable<string>): CsNames;
  csIdentifier(raw: string, c: NameCase): string;    // 先頭数字は '_'、空は '_'
  escapeKeyword(id: string): string;                 // C# キーワードは '@'
  // types.ts
  type CsType = { code: string; valueType: boolean; key: string /* JSON context 登録用。値型の nullable は 'int?' */ };
  class CsTypeResolver { constructor(ir, names, opts, diagnostics); typeOf(schema: IRSchema, path: SchemaPath, usage: 'model' | 'parameter'): CsType; registered(): CsType[] }
  // models.ts / json-context.ts
  renderModels(ctx, names, resolver, plan: UnionPlan): EmittedModel[];   // { file: 'Models/<File>.cs', content }
  type UnionPlan = { polymorphic: Map<string, { property: string; variants: Map<string, string> }>; baseOf: Map<string, string> };
  planUnions(ir: IRDocument): UnionPlan;
  renderJsonContext(ctx, resolver, contextName = 'ApiJsonContext'): string;
  // runtime.ts
  readCsRuntime(dir: string): RuntimeFile[];                     // *.cs（bin / obj を除く）を名前順
  rewriteNamespace(source: string, namespace: string): string;  // 'Archon.Runtime' → '<namespace>.Core'
  runtimeTypeNames(files: RuntimeFile[]): Set<string>;          // public / internal な class / struct / record / enum / interface / delegate 名
  ```
  `irRequirements`: `{ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }`。
  型対応（`typeMappings['kind:format']` → `typeMappings['kind']` → `hooks.typeOverride` の順に優先）: string → `string`（`date-time` → `DateTimeOffset`、`date` → `DateOnly`、`time` → `TimeOnly`、`uuid` → `Guid`、`byte` → `byte[]`）、integer → `int`（`int64` → `long`）、number → `double`（`float` → `float`）、boolean → `bool`、binary → `ApiFile`、unknown / null / tuple / 平坦化されなかった intersection → `JsonElement`、array → model では `List<T>`・parameter では `IReadOnlyList<T>`、プロパティを持たない object → additionalProperties があれば `Dictionary<string, T>`、無ければ `Dictionary<string, JsonElement>`、const → 値の型（string / long / double / bool）。named schema のうち object（プロパティあり）/ enum / union だけが型を宣言し、それ以外（配列・プリミティブ・map の別名）は参照先の型を展開する（循環すれば `JsonElement`）。nullable または optional なら `?`。
  モデル出力（1 schema 1 ファイル `Models/<Name>.cs`、`namespace <Namespace>;`、ファイル先頭に生成ヘッダと `#nullable enable` / `#pragma warning disable CS0612, CS0618`）:
  - object → `public sealed partial class X`（polymorphic 基底は非 sealed、バリアントは `: Base`）。プロパティは `[JsonPropertyName("wire")]` 付きの `{ get; set; }`、必須は `required`、optional は `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]`。additionalProperties とプロパティの両方を持つなら `[JsonExtensionData] public Dictionary<string, JsonElement>? AdditionalProperties`。description は `/// <summary>`（`&` `<` `>` をエスケープ）、deprecated は `[Obsolete]`。multipart body としてだけ使われる schema の `ApiFile` プロパティは `[JsonIgnore]`（Task 7 がファイル部を別途追加する）。
  - enum → 拡張 enum 構造体（「意図的な差分」参照）: `public readonly partial struct X : IEquatable<X>`、`X(string value)`（integer は `long`、number は `double`）、`Value`、既知値ごとの `public static X <Member> { get; } = new(...)`、`IsKnown`、`KnownValues`、`==` / `!=`、`ToString()`、`[JsonConverter(typeof(XJsonConverter))]` と同ファイルの `internal sealed class XJsonConverter : JsonConverter<X>`。メンバー名は値の PascalCase（数字始まりは `_`、`Value` / `IsKnown` / `KnownValues` と衝突すれば接尾辞）。`default(X).ToString()` は `""`。
  - polymorphic union（`planUnions` が選んだもの）→ `[JsonPolymorphic(TypeDiscriminatorPropertyName = "<prop>", IgnoreUnrecognizedTypeDiscriminators = true)]` + マッピングごとの `[JsonDerivedType(typeof(V), "<tag>")]` を付けた `public partial class X { [JsonExtensionData] public Dictionary<string, JsonElement>? AdditionalProperties { get; set; } }`。バリアントは判別プロパティを出力しない。適用条件: 判別あり、全バリアントが nullable でない object 型 named schema への ref、各バリアントがちょうど 1 つの polymorphic union にしか属さない、マッピング先が重複しない、バリアント自身が polymorphic 基底でない。
  - それ以外の union → `[JsonConverter(typeof(XJsonConverter))] public sealed partial class X`: バリアントごとの public コンストラクタと implicit 変換、型名から付けたアクセサ（`Cat? Cat`、値型は `double? Double`、配列は `CatList`。衝突は UniqueNamer）、`object? Value`、`JsonElement? Unknown`、`static X FromUnknown(JsonElement raw)`。converter の Read は `JsonDocument.ParseValue` → 判別ありならタグでバリアントを選び（未知なら Unknown）、判別なしならバリアントを宣言順に `Deserialize(element, (JsonTypeInfo<V>)options.GetTypeInfo(typeof(V)))` して `JsonException` でなければ採用、全滅なら Unknown。Write は保持している値をその型で書く（Unknown は生 JSON）。
  JSON context（`ApiJsonContext.cs`）: `[JsonSourceGenerationOptions(AllowOutOfOrderMetadataProperties = true)]`、`CsTypeResolver.registered()`（全モデル + パラメータ・body・レスポンス・union バリアントで使った型）を `[JsonSerializable(typeof(T), TypeInfoPropertyName = "<名前>")]` で列挙する。名前はモデルなら型名、それ以外は型式から作る（`List<string>` → `ListOfString`、`int?` → `NullableInt32`、`Dictionary<string, string>` → `DictionaryOfStringString`）。context の既存メンバー（`Default`, `Options`, `GetTypeInfo`, `GeneratedSerializerOptions`）と衝突すれば接尾辞。生成コードは `ApiJsonContext.Default.<名前>` で型情報を参照する（未登録ならコンパイルエラーになる）。
  名前の予約: 型名はランタイムの型名（`runtimeTypeNames`）、`ApiJsonContext`、`ApiAuth`、`<clientName>`、`<clientName>Options`、サービス名と衝突させない。メンバー名は C# キーワード以外に `GetType` / `Equals` / `GetHashCode` / `ToString` / `MemberwiseClone` / `AdditionalProperties` と囲む型名（衝突時は `<Name>Value`）を避け、クラス内で UniqueNamer（case-sensitive）を使う。

- [ ] **Step 1:** 失敗するテストを書く（`helpers.ts` で小さな IR とプラグイン ctx を組み、出力文字列を `toContain` / 完全一致で比較する）。
  - names: `sanitizes type and member names`: schema `Foo.Bar` → `FooBar`、`1Thing` → `_1Thing`、`foo-bar` → `FooBar2`、`ApiRequest` → `ApiRequest2`、プロパティ `x-foo` → `XFoo`、`2fa` → `_2fa`、`foo_bar` と `fooBar` → `FooBar` / `FooBar2`、`Echo.echo` → `EchoValue`（Review Focus）。`escapeKeyword('class') === '@class'`。
  - types: `maps formats and nullability`（date-time / date / uuid / int64 / float / binary / unknown、optional → `?`）、`expands non-object named schemas`、`falls back to JsonElement on alias cycles`、`applies typeMappings and typeOverride`、`uses IReadOnlyList for parameters`。
  - models:
    - `renders required, optional and nullable properties with JsonPropertyName`: `public required string Name { get; set; }` と、optional の `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` + `public string? Note { get; set; }`。
    - `renders self-referencing schema by name`: `public required List<Node> Children { get; set; }`（Review Focus）。
    - `renders extensible enum struct with known values and converter`（`Status.Active`, `IsKnown`, integer enum `Priority._1` の `long` 値）。
    - `renders polymorphic base and derived variants without the discriminator property`（`[JsonDerivedType(typeof(Circle), "circle")]`、`Circle : Shape` に `Kind` が無い）。
    - `falls back to a wrapper converter when a variant belongs to two unions`。
    - `renders untagged union wrapper with accessors and try-in-order converter`（`Pet` に `Cat? Cat` / `Dog? Dog` / `Unknown`）。
    - `renders a union of string and object`（`string? String` アクセサ）。
    - `marks deprecated schemas Obsolete and escapes XML doc`。
    - `JSON context registers models and parameter types with stable names`（`[JsonSerializable(typeof(global::System.Collections.Generic.List<string>), TypeInfoPropertyName = "ListOfString")]`）。
  - runtime: `copies runtime files and rewrites the namespace`、`runtimeTypeNames lists public runtime types`、`excludes bin and obj`。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/plugins/csharp` → FAIL。
- [ ] **Step 3:** 実装する。生成コード内の BCL 型は `global::` 付きの完全修飾で書くか、各ファイル冒頭の `using System; using System.Collections.Generic; using System.Text.Json; using System.Text.Json.Serialization;` に限定する（モデル名との衝突を避けるため、`using` は上記 4 つと `<Namespace>.Core` のみ）。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-cs): emit C# models, unions, enums and JSON context`。

## Task 7: C# plugin — サービス / ApiClient / ApiAuth / csproj / ランタイムのコピー

**Files:**
- Create: `packages/archon/src/plugins/csharp/{services,client,project}.ts`
- Modify: `packages/archon/src/plugins/csharp/index.ts`
- Test: `packages/archon/test/plugins/csharp/{services,client}.test.ts`

**Interfaces:**
- Consumes: Task 2–5 のランタイム公開 API（名前を文字列で埋め込む）、Task 6 の `CsNames` / `CsTypeResolver` / `UnionPlan`
- Produces（生成物の構造。E2E とカスタムプラグインが依存する）:
  ```
  <outputDir>/
    <PackageName>.csproj       # package !== false のとき
    <ClientName>.cs            # <ClientName>, <ClientName>Options
    ApiAuth.cs
    ApiJsonContext.cs          # Task 6
    Models/*.cs                # Task 6
    Services/<Group>Service.cs
    Core/*.cs                  # runtimes/csharp/src/*.cs のコピー（namespace 書き換え済み）
  ```
  サービス（group ごと、無ければ `Default`。クラス名 `<PascalGroup>Service`、`<ClientName>` のプロパティ名 `<PascalGroup>`）:
  ```csharp
  public sealed partial class EchoService
  {
      private readonly ApiClientCore _core;
      internal EchoService(ApiClientCore core) => _core = core;
      /// <summary>…</summary> <param name="simple">…</param>（IRParameter.description、無ければ schema.description）
      public async Task<Echo> EchoPathStylesAsync(IReadOnlyList<string> simple, …, RequestOptions? requestOptions = null, CancellationToken cancellationToken = default)
          => (await EchoPathStylesWithResponseAsync(simple, …, requestOptions, cancellationToken).ConfigureAwait(false)).Data;
      public Task<ApiResult<Echo>> EchoPathStylesWithResponseAsync(…)
      {
          var values = new RequestValues()
              .Path("simple", simple, ApiJsonContext.Default.IReadOnlyListOfString)
              …;
          return _core.SendAsync(EchoPathStylesSpec, values, ResponseDecoder.Json(ApiJsonContext.Default.Echo), EchoPathStylesErrors, requestOptions, cancellationToken);
      }
      private static readonly OperationSpec EchoPathStylesSpec = new(…);
      private static readonly ErrorDecoders EchoPathStylesErrors = new ErrorDecoders().Json("401", ApiJsonContext.Default.Error);
  }
  ```
  - 引数順: path（テンプレート順）→ 必須 body → 必須 query / header / cookie（宣言順）→ optional body → optional query / header / cookie → `RequestOptions? requestOptions = null` → `CancellationToken cancellationToken = default`。optional は `= null`（値型は `T?`）。名前は camelCase + キーワードは `@`、衝突は UniqueNamer（`requestOptions` / `cancellationToken` / `values` / `body` を予約）。
  - 成功型: 最小ステータスの 2xx（無ければ `2XX`）。content 無しなら `Task` / `Task<ApiResult>` と非ジェネリック `SendAsync`。json → `ResponseDecoder.Json`、text / form / multipart → `ResponseDecoder.Text`（`string`）、binary → `ResponseDecoder.Binary`（`byte[]`）。
  - エラー: 非 2xx の各レスポンスで json → `.Json(status, info)`、text → `.Text(status)`（`ApiException<string>`）。status キーは `'404'` / `'4XX'` / `'default'`。
  - body: json → `.JsonBody(body, info)`、form → `.FormBody(body, info)`、multipart → `.Body(MultipartBody.FromJson(JsonSerializer.SerializeToElement(body, info)).AddFile("file", body.File).AddFiles("attachments", body.Attachments))`（`ApiFile` / `List<ApiFile>` のプロパティだけ AddFile / AddFiles）、text → `.TextBody(body)`、binary → `.BinaryBody(body)`。form / multipart の schema が object でなければ引数型をランタイムの `FormBody` / `MultipartBody` にして `.Body(body)` を渡す。GET / HEAD の body は M1 と同じく warn `request-body-ignored` して出力しない。
  - include / exclude（`matchesPattern`、exclude 優先）を通らない操作は出力しない（モデルは出力する）。deprecated の操作は `[Obsolete]`。
  クライアント:
  ```csharp
  public sealed partial class ApiClient
  {
      public const string DefaultBaseUrl = "http://localhost:4010";            // servers[0] を変数 default で展開
      public static IReadOnlyDictionary<string, SecuritySchemeSpec> SecuritySchemes { get; } = …;  // http-other / mutualTLS は出さない
      public ApiClient() : this(new ApiClientOptions()) { }
      public ApiClient(ApiClientOptions options) { … Echo = new EchoService(_core); … }
      public ApiClientOptions Options { get; }
      public EchoService Echo { get; }
      public ApiClient Use(IApiMiddleware middleware);
  }
  public sealed class ApiClientOptions : ClientOptions<ApiAuth> { public ApiClientOptions() { BaseUrl = ApiClient.DefaultBaseUrl; } }
  public sealed class ApiAuth : IAuthConfig { public TokenValue? BearerAuth { get; set; } public BasicValue? BasicAuth { get; set; } public OAuth2Value? OAuth2 { get; set; } …
      object? IAuthConfig.Get(string scheme) => scheme switch { "bearerAuth" => BearerAuth, …, _ => null }; }
  ```
  スキーム → 値型: http-bearer / apiKey → `TokenValue`、http-basic → `BasicValue`、oauth2 / openIdConnect → `OAuth2Value`。oauth2 の tokenUrl / refreshUrl は M1 と同じく clientCredentials → authorizationCode → password の順。
  csproj（`package` から）: `<PackageId>` / `<AssemblyName>` / `<RootNamespace>` = 名前（既定は namespace）、`<Version>`（既定 `info.version`。`^\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?$` に合わなければ `1.0.0` にして warn `csharp-invalid-version`）、`<Description>`、`<Authors>`、`<PackageLicenseExpression>`、Global Constraints のプロパティ、`<GenerateDocumentationFile>true</GenerateDocumentationFile>` + `<NoWarn>$(NoWarn);CS1591</NoWarn>`。PackageReference は持たない。
  ランタイムのコピー: `resolveRuntimeDir('csharp', { marker: 'ApiClientCore.cs' })` → `readCsRuntime` → `rewriteNamespace` → 生成ヘッダを付けて `Core/<file>` に emit。

- [ ] **Step 1:** 失敗するテストを書く。
  - services: `orders parameters path, required, optional, then requestOptions and cancellationToken`、`renames colliding parameter names`（path `id` と query `id` → `id` / `id2`。Review Focus）、`escapes keyword parameter names`（`class` → `@class`）、`emits OperationSpec with styles, security and responses`、`picks the lowest 2xx response type`、`returns Task for no-content operations`、`emits error decoders per status`、`encodes multipart files with AddFile/AddFiles`、`uses runtime FormBody for non-object form bodies`、`plugin include/exclude limits generated operations`、`uses methodName hook and naming.method template`。
  - client: `emits DefaultBaseUrl with server variables expanded, SecuritySchemes and ApiAuth per scheme kind`、`names services after groups and avoids reserved member names`、`emits csproj with package metadata and falls back on invalid versions`、`package false skips csproj`。
  - index: `symbols.typeOf and symbols.operation return generated names`。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/plugins/csharp` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-cs): emit services, client, auth, csproj and vendored runtime`。

## Task 8: スナップショットとコンパイルテスト

**Files:**
- Modify: `packages/archon/test/e2e-generate/snapshot.test.ts`
- Create: `packages/archon/test/e2e-generate/csharp-compile.test.ts`, `packages/archon/test/e2e-generate/__snapshots__/csharp/**`

**Interfaces:**
- Consumes: `generate()`、`csharp()`、`fixtures/specs/{petstore.yaml,edge-cases.yaml,natsuneko.json}`

- [ ] **Step 1:** 失敗するテストを書く。
  - snapshot: petstore と edge-cases を `csharp({ output: '.' })` で生成し、info 以外の診断が無いこと、`Core/` 以外の全ファイルを `__snapshots__/csharp/<spec>/<file>` と比較すること。
  - compile（`dotnet` が PATH に無ければ `describe.skip`。各ケース timeout 300 秒、逐次）: 生成先で `dotnet build -c Release -warnaserror -nologo` を実行し終了コード 0 を assert する。ケース: petstore、edge-cases、natsuneko（既定）、natsuneko（`namespace: 'Natsuneko.Api'`, `clientName: 'NatsunekoClient'`, `typeMappings: { 'string:date-time': 'string' }`）、natsuneko（`filters.schemas.include: ['/^Album/']`）。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/e2e-generate` → snapshot 作成 / compile 失敗を確認し、プラグインを直して通す。
- [ ] **Step 3:** snapshot を目視確認する（型名、`required` / `?`、XML doc、サービスの引数順、JSON context の登録漏れが無いこと）。`pnpm test` 全体が PASS。
- [ ] **Step 4:** Commit `test: add snapshot and dotnet build tests for C# output`。

## Task 9: C# E2E

**Files:**
- Create: `e2e/csharp/{package.json,scripts/run.mjs,scripts/generate.mjs,tests/Archon.E2E.Tests.csproj,tests/*.cs}`
- Modify: root `package.json`（`test:e2e:csharp`）、`.gitignore`

**Interfaces:**
- Consumes: `startMockServer()`（`e2e/mock-server`、変更しない）、`generate()`、生成 SDK（`e2e/csharp/generated/EdgeCases/Archon.EdgeCases.csproj`、namespace `Archon.EdgeCases`）
- Produces: `pnpm test:e2e:csharp` — `run.mjs` が jiti でモックサーバと archon の src を読み込み、`generate({ input: 'fixtures/specs/edge-cases.yaml', output: 'e2e/csharp/generated', plugins: [csharp({ output: 'EdgeCases', namespace: 'Archon.EdgeCases' })] })` → `startMockServer()` → 環境変数 `ARCHON_E2E_BASE_URL` / `ARCHON_E2E_SECONDARY_URL` を付けて `dotnet test e2e/csharp/tests` を stdio 継承で実行 → サーバを閉じ、dotnet の終了コードで終了する。`Support.cs` は環境変数、`new ApiClient(new ApiClientOptions { BaseUrl = … })` ヘルパー、`GET /__stats` の読み取りを提供する。xUnit は `[assembly: CollectionBehavior(DisableTestParallelization = true)]`（`/__stats` を前後比較するため）。

シナリオ（TS E2E と同じ。期待値も同じで、C# の差分は「常に例外」と型の違いだけ）:
- [ ] **Step 1:** テストを書く。
  - Params: `SerializesAllPathStyles`（`/echo/path/a,b/.a.b/;x=1;y=2`）、`PercentEncodesReservedCharacters`（`/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2`）、`SerializesAllQueryStyles`（TS と同じ 7 項目を `&` 連結した文字列と完全一致）、`OmitsUnsetQueryParameters`（`limit=1`）、`SendsHeaderArrayAndCookies`（`x-request-ids: a,b`、`cookie: theme=dark; tags=x,y`）。
  - Bodies: JSON（`contentType == "application/json"`、エコー body を `JsonPayload` として読み直して一致。`Note = null` は送られない）、form（`name=a+b%26c&count=2&tags=x&tags=y`）、multipart（`files` が `[file data.bin 10, attachments a.txt 3, attachments b.txt 5]`、body が `{"title":"hello"}`）、binary（`content-length: 9`、`raw bytes`）、text、`createNode` の再帰ツリー（`WithResponseAsync` で `StatusCode == 201`、ids `n1`–`n4` と `ParentId`）。
  - Responses: text `hello, archon`、binary 256 バイト（先頭 0x00、末尾 0xff）、204 は `StatusCode == 204` で例外なし、空 JSON は `null`。
  - Unions: shapes の 3 要素が `Circle(1)` / `Square(2)` / 正確に `Shape` 型（`AdditionalProperties["side"] == 3`）、pets は `Cat` / `Dog` アクセサで判別、enums は `Status.Active`、`Priority._2`、`statuses[1].IsKnown == false` かつ `Value == "archived"`、`Color == null`、`Level.Value == "unknown-level"`、dates は `DateTimeOffset` / `DateOnly`（ネスト配列と `byKey` を含む。値は TS の期待値と同じ瞬間）。
  - Auth: bearer / basic / apiKey header・query（`query == "api_key=test-key"`）・cookie、誤った bearer は `ApiException<Error>`（401、`Code == 401`）、未設定は `ApiAuthException`（`Schemes == ["bearerAuth"]`）でサーバに届かない、optional は未設定で匿名・設定済みで bearer、AND は片方だけなら `ApiAuthException`、oauth2 は clientCredentials で 200 と発行 +1、refresh grant で `OnRefreshed` が新しい refresh token で 1 回、2.1 秒後の再呼び出しで先回り更新（発行 +2、`/auth/oauth2` へのリクエスト +2）、コールドクライアント 5 並行で発行 1 回かつ同一 Authorization。
  - Middleware: retry で `fail=2` → `{ key, attempts: 3 }`、`MaxAttempts = 2` で `ApiException<Error>`（503）、retry401 + トークン差し替えで成功（`onUnauthorized` が `Attempt == 1` で 1 回）、logging のマスク（1 行目が `→ GET {baseUrl}/echo/headers?api_key=***`、ヘッダ行に `authorization: ***` / `x-api-key: ***` / `cookie: ***` / `x-request-ids: r1`、ログ全体に `test-token` / `test-key` / `dark` が無い、最終行が `← 200 (Nms)`）、userAgent、登録順（`x-trace == "a,b,c"`、順序 `>a >b >c <c <b <a`、`c` は `client.Use`）。
  - Errors: 200 は `{ Ok = true }`、404 は `ApiException<NotFoundError>`（`Resource == "errors/404"`）、400 は `ApiException<ValidationError>`、418 は default の `ApiException<Error>`（`Code == 418`）、500 も同様。
  - Redirect: `apiKeyHeader` + `Headers["Authorization"]` を付けて `redirectCrossOrigin` → `WithResponseAsync` の `Url` が secondary のオリジン、エコーの `path == "/echo/headers"`、`x-api-key` / `authorization` が無い。
- [ ] **Step 2:** `pnpm test:e2e:csharp` を実行し、失敗をランタイム / プラグインの修正で解消する（期待値は TS と揃え、緩めない）。
- [ ] **Step 3:** ルートで `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`dotnet test runtimes/csharp/tests/Archon.Runtime.Tests` がすべて通ることを確認する。
- [ ] **Step 4:** Commit `test: add C# end-to-end suite against the mock server`。

## Task 10: README と例

**Files:**
- Modify: `README.md`, `examples/natsuneko/archon.config.ts`

- [ ] **Step 1:** `examples/natsuneko/archon.config.ts` に `csharp({ output: 'csharp', namespace: 'Natsuneko.Api' })` を追加する。
- [ ] **Step 2:** README に C# の節を追加する: 生成物の構成、`new ApiClient(new ApiClientOptions { BaseUrl, Auth = new ApiAuth { BearerAuth = "…" } })`、`client.Catalyst.GetXAsync(...)` と `WithResponseAsync`、例外の種類、middleware（`IApiMiddleware` と標準 4 種、`client.Use`）、OAuth2、独自 `HttpClient` の条件（`AllowAutoRedirect = false` / `UseCookies = false`）、拡張 enum と union の使い方と制約（「意図的な差分」）、`dotnet test` / `pnpm test:e2e:csharp` の実行方法、ロードマップの M2 を完了にする。
- [ ] **Step 3:** Commit `docs: document the C# plugin and runtime`。
