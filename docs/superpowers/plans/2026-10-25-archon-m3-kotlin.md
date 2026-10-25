# Archon M3（Kotlin）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kotlin（JVM 11+ / Android）言語プラグインと、`ktor-client-core` + `kotlinx-serialization-json` だけに依存する手書き Kotlin ランタイムを実装する。`edge-cases.yaml` と `natsuneko.json` から生成した Kotlin SDK が `gradle build`（警告ゼロ）を通り、TypeScript / C# と同じ E2E シナリオがモックサーバに対して通ることを完了条件とする。

**Architecture:** `runtimes/kotlin` を Gradle の Kotlin/JVM ライブラリ（package `archon.runtime`、Gradle wrapper 同梱）として置き、生成時に出力先 `src/main/kotlin/<package>/core/` へ package を `<package>.core` に書き換えてコピーする。Kotlin プラグイン（`packages/archon/src/plugins/kotlin`）は inline の object / enum / union を巻き上げた IR（M2 で追加済みの `hoistInlineUnions` を使う）から、モデル（`models/*.kt`）、タグ別サービス（`services/*.kt`、suspend 関数）、`ApiClient` / `ApiAuth`、`build.gradle.kts` / `settings.gradle.kts` を出力する。E2E は既存の `e2e/mock-server` を Node スクリプトで起動し、生成 SDK を composite build で取り込む JUnit 5 プロジェクトを `runtimes/kotlin/gradlew -p e2e/kotlin test` で実行する。

**Tech Stack:** Kotlin 2.4.21（`kotlin("jvm")` + `kotlin("plugin.serialization")`）、Gradle 9.8.1（wrapper）、Ktor 3.6.0（`ktor-client-core`）、kotlinx-serialization-json 1.11.0、JDK 17（ビルド用。生成物は `jvmTarget 11`）。テストのみ: `kotlin-test-junit5`、`kotlinx-coroutines-test` 1.11.0、`ktor-client-mock` / `ktor-client-cio` / `ktor-client-okhttp` / `ktor-client-android` 3.6.0。既存の Node 24 / pnpm 10 / vitest ^3.2 / jiti ^2

**Spec:** `docs/superpowers/specs/2026-10-25-archon-design.md`（特に §6 生成 SDK 共通仕様、§7 Kotlin 列と注記、§8 認証、§10 テスト戦略）。構成と規約は M1（`docs/superpowers/plans/2026-10-25-archon-m1-core-typescript.md`）と M2（`docs/superpowers/plans/2026-10-25-archon-m2-csharp.md`）に従う。挙動の規則は M2 の各タスクと同じものを Kotlin に写し、ここでは差分だけを書く。

## Global Constraints

- 生成 Kotlin SDK とランタイムの依存は `io.ktor:ktor-client-core` と `org.jetbrains.kotlinx:kotlinx-serialization-json` のみ（どちらも `api`）。engine は利用者が選ぶ（spec §7 注記: 既定 engine は OkHttp ではなく利用者選択、`HttpClient` を受け取る）。kotlinx-coroutines は ktor-client-core 経由で使ってよい。
- 対象: JVM 11+ / Android。生成 `build.gradle.kts` とランタイムは `jvmTarget = JVM_11`、`-Xjdk-release=11`、`java { sourceCompatibility = targetCompatibility = VERSION_11 }`、`explicitApi()`。ランタイムは `java.time`、`java.util.Base64`、`java.net.http`、`java.util.concurrent.CompletableFuture` を使わない（Android の API レベル差を避ける。base64 は `kotlin.io.encoding.Base64`、時刻はミリ秒の `() -> Long`、待機は `kotlinx.coroutines.delay`）。
- 生成コードとランタイムは警告ゼロ（コンパイルテストは init script で `allWarningsAsErrors = true`）。リフレクションによる serializer 探索（`serializer<T>()`、`KClass.serializer()`）は使わず、生成コードは型ごとの serializer 式（`String.serializer()`、`ListSerializer(Cat.serializer())` 等）を明示する（R8 / ProGuard 安全）。
- 型対応（spec §7 Kotlin 列）: `date-time` → `String`、`int64` → `Long`、`uuid` → `String`、`uri` → `String`、nullable / optional → `T? = null`。
- 判別あり union → sealed interface + 判別値で選ぶ serializer、判別なし union → 内容で順に試す serializer（spec §7。実装は下の「意図的な差分」）、enum → 未知値を保持する型（spec §6.6）。
- 予約語はバッククォート（spec §7）。
- API 形状は `client.<group>.<method>(...)` の suspend 関数、戻り値は成功ボディ、非 2xx は `ApiException`（spec §7）。
- Middleware は `fun interface Middleware { suspend fun intercept(request: ApiRequest, next: suspend (ApiRequest) -> ApiResponse, context: CallContext): ApiResponse }`（spec §6.2 そのまま）。登録順に外側から実行し、認証適用は最内側（transport 直前）。
- 標準 middleware・認証・OAuth2・リダイレクト時の資格情報除去・再送可能リクエストの規則と既定値は TS / C# と同一（M1 Task 15–16、M2 Task 3–5）。
- パラメータ直列化・エンコード結果は TS / C# ランタイムとバイト単位で一致させる（M1 Task 13 の表、M2 Task 2 の追加ケース）。
- requestBody の media type 優先順は json > multipart > form > text > binary（IR で並べ替え済み、`contents[0]` を採用）。
- 生成物の各ファイル先頭には生成ヘッダ（`// ` コメント、`output.header` で上書き可）を付与する。
- バージョン定数（Kotlin 2.4.21 / Ktor 3.6.0 / kotlinx-serialization 1.11.0）はプラグインの `project.ts` に 1 か所だけ置き、`runtimes/kotlin/build.gradle.kts` と `e2e/kotlin/build.gradle.kts` の値と一致することをテストで保証する。

## Spec からの M3 における意図的な差分

- **enum は Kotlin `enum class` ではなく「拡張可能 enum」クラス**（M2 の拡張 enum 構造体と同じ考え方）: `@Serializable(with = Status.Serializer::class) public class Status(public val value: String)`、既知値は `companion object` の `public val Active: Status = Status("active")`、`isKnown`、`knownValues`、`equals` / `hashCode` / `toString`。`enum class` では未知値の生の値を保持できず、再送時に値が壊れる（§6.6 の `Unknown(raw)` を満たせない）ため。`when (status) { Status.Active -> … else -> … }` で分岐できる（未知値があるので `else` は必須で、それが前方互換の意図どおり）。value class にしないのは、公開関数の JVM 名がマングルされるのを避けるため。
- **union は sealed interface + 生成した `KSerializer`**: `JsonContentPolymorphicSerializer` は書き込み時に `KClass.serializer()`（リフレクション）を使い、未知の形を値として保持できないので使わない。代わりに union ごとに `object Serializer : KSerializer<U>` を生成し、読み込みは `JsonDecoder.decodeJsonElement()` → 判別ありなら判別値でバリアントを選び、判別なしならバリアントを宣言順に `decodeFromJsonElement` して最初に成功したもの、どれも合わなければ `U.Unknown(raw: JsonElement)`。書き込みは `when (value)` で各バリアントの serializer を明示する。選択の意味論は spec の `JsonContentPolymorphicSerializer` と同じ。
  - 名前付き object のバリアントは data class 自身が sealed interface を実装する（`data class Cat(...) : Pet`）。Kotlin は複数 interface を実装できるので、C# と違い 1 つの object が複数の union に属してよい。それ以外（プリミティブ・配列・map・enum・別の union）は入れ子のラッパー（`Pet.StringValue(val value: String)`、`Pet.CatList(val value: List<Cat>)`）。
  - 判別プロパティはバリアントのクラスに残す（C# のように消さない）。判別あり union のマッピング先がちょうど 1 つのタグを持つバリアントでは、判別プロパティに既定値（タグ）と `@EncodeDefault` を付け、利用者が書かなくてよく、単独で直列化しても判別値が出るようにする。未知の判別値は `Unknown` に生 JSON ごと（判別値を含めて）保持される。
- **`ApiException` は非ジェネリック**: Kotlin は `Throwable` のサブクラスに型パラメータを許さないので、型付きエラーボディは `val body: Any?` に入れ、`inline fun <reified T> ApiException.bodyAs(): T?` で取り出す。
- **成功 JSON の戻り値型は schema の nullable に従い、空 body は null にしない**: 型が non-null で応答が空（204 / 空 body）なら `ApiDecodeException`（`rawBody == ""`）。C# は参照型の `null` を返すが、Kotlin の null 安全を壊すため。schema が nullable なら `null` を返す。E2E の「空 JSON」シナリオは Kotlin ではこの例外を期待値にする。
- **`throwOnError` は無い**: C# と同じく常に例外。各操作に `<method>WithResponse`（`ApiResult<T>`、status / headers / 最終 URL）を併せて生成する（M2 の決定を踏襲）。no-content の操作は `Unit` / `ApiResult<Unit>`。
- **キャンセル**: コルーチンのキャンセルは `CancellationException` をそのまま伝える（包まない）。`CallContext` にキャンセルトークンは持たない（`coroutineContext` が担う）。タイムアウトと通信失敗は `ApiTransportException`（タイムアウトは `timedOut = true`）。
- **省略可能プロパティの null は書かない**: `Json { encodeDefaults = false; explicitNulls = true; ignoreUnknownKeys = true }`。optional は `= null` の既定値を持つので未設定は出力されず、required + nullable の `null` は出力される。required なプロパティが応答に無ければ `ApiDecodeException`（C# の `required` と同じ）。
- **date-time / date / uuid は `String`**（spec §7 の既定）。spec の opt `kotlinx.datetime.Instant` は M3 では専用オプションにせず、`typeMappings`（serializer 式付き）と `package.dependencies` で利用者が差し替えられるようにする。`format: byte` も `String`（base64 のまま）。
- **additionalProperties とプロパティを両方持つ object の追加プロパティは保持しない**（spec §6.6「未知プロパティは無視」）。プロパティを持たない object は `Map<String, T>`。
- **生成 SDK に Gradle wrapper は含めない**（バイナリを生成物に含めないため）。生成物は `build.gradle.kts` / `settings.gradle.kts` と `src/main/kotlin` だけで、利用者の Gradle か、このリポジトリでは `runtimes/kotlin/gradlew -p <dir>` でビルドする。

## Review Focus

- **Ktor / engine による URL の書き換え**（query `piped=1|2&filter[a]=b`、path の `%2F`、`%41`）→ どの engine でもリクエスト行がランタイムの直列化結果とバイト単位で一致する（`URLBuilder` の再エンコードや正規化で `|` が `%7C`、`%41` が `A` にならない）。→ Task 2 に engine 別（CIO / OkHttp / Android）のテストを追加。
- **利用者が渡した `HttpClient` が自動リダイレクト・`expectSuccess`・`DefaultRequest` 等を設定済み**→ ランタイムは `httpClient.config { followRedirects = false; expectSuccess = false }` の派生クライアントで送信し、手動リダイレクトで cross-origin の資格情報が除去される。`ApiClient.close()` は利用者の `HttpClient` / engine を閉じない（自分で作った既定クライアントだけ閉じる）。→ Task 2 にテストを追加。
- **Kotlin 識別子として不正・衝突する名前**（プロパティ `x-foo` / `2fa` / `class`（JVM getter `getClass` と衝突）/ `when` / `foo_bar` と `fooBar`、schema 名 `String` / `List` / `Result` / `Unit` / `Any` / `ApiRequest` / `Serializable` / `Json`、union のバリアントになる schema `Unknown` / `Serializer`、description 中の `*/` `/*` `$`）→ 正規化され、衝突は接尾辞、キーワードはバッククォート、ワイヤ名は `@SerialName` で保持され、`gradle build` が警告ゼロで通る。→ Task 5、Task 7（stress ケース）にテストを追加。
- **自己参照 / 相互参照する schema と union**（`Node.children: List<Node>`、判別なし `U1 = U2 | string` と `U2 = U1 | int`）→ 生成とコンパイルが通り、読み込み時に serializer が互いを無限に呼ばない（C# の `wrapperVariants` と同じ平坦化）。→ Task 5 にテスト、Task 7 の stress ケースで確認。
- **同時リクエストとコルーチンのキャンセル**（コールドクライアントで 5 並行、うち 1 つを途中で cancel、また `timeout` 経過と呼び出し側 cancel の区別）→ トークン取得は 1 回、cancel した呼び出しだけが `CancellationException` になり残りは成功する。タイムアウトは `ApiTransportException(timedOut = true)`、呼び出し側 cancel は `CancellationException` のまま。→ Task 2、Task 3 にテストを追加。

---

## File Structure

```
packages/archon/
  scripts/copy-runtimes.mjs             # Task 5: kotlin の src/test、build/、.gradle/ を除外
  src/plugins.ts                        # Task 5: kotlin を export
  src/plugins/kotlin/
    index.ts        # definePlugin 本体・オプション・symbols API
    reserved.ts     # Kotlin キーワード、予約メンバー名、予約型名
    names.ts        # 型名・プロパティ名・パラメータ名・package 名
    emit.ts         # ktFile（ヘッダ・package・import）、KDoc、文字列リテラル
    types.ts        # IRSchema → Kotlin 型 + serializer 式（KtTypeResolver）
    models.ts       # models/*.kt（data class / 拡張 enum / sealed union + serializer）
    services.ts     # services/*.kt
    client.ts       # <ClientName>.kt（ApiClient, ApiClientOptions）、ApiAuth.kt
    project.ts      # build.gradle.kts / settings.gradle.kts、バージョン定数
    runtime.ts      # ランタイムの読み込みと package 書き換え
  test/plugins/kotlin/{helpers,names,types,models,services,client,runtime,versions}.test.ts
  test/e2e-generate/snapshot.test.ts    # Task 7: Kotlin を追加
  test/e2e-generate/kotlin-compile.test.ts   # Task 7
  test/e2e-generate/kotlin-warnings.init.gradle.kts  # Task 7: allWarningsAsErrors
  test/e2e-generate/__snapshots__/kotlin/{petstore,edge-cases}/**

runtimes/kotlin/
  settings.gradle.kts  build.gradle.kts  gradle.properties
  gradlew  gradlew.bat  gradle/wrapper/{gradle-wrapper.jar,gradle-wrapper.properties}
  src/main/kotlin/archon/runtime/
    {Specs,ApiHeaders,Errors,PercentEncoding,ParameterSerializer,RequestValues,ApiJson,
     ApiBody,ApiFile,ApiRequest,ApiResponse,ApiResult,Decoders,Middleware,Transport,
     ClientOptions,ApiClientCore,Auth,OAuth2TokenManager,StandardMiddleware}.kt
  src/test/kotlin/archon/runtime/*Test.kt   # TestServer は ServerSocket 製の最小 HTTP/1.1

e2e/kotlin/
  package.json                          # @natsuneko-laboratory/archon-e2e-kotlin（private）
  scripts/{run.mjs,generate.mjs}
  settings.gradle.kts                   # includeBuild("generated/EdgeCases")
  build.gradle.kts                      # implementation("archon.e2e:edge-cases") + ktor-client-cio
  src/test/kotlin/archon/e2e/{Support,ParamsTest,BodiesTest,ResponsesTest,UnionsTest,AuthTest,MiddlewareTest,ErrorsTest,RedirectTest}.kt
```

ルート `package.json` に `"test:e2e:kotlin": "pnpm -F @natsuneko-laboratory/archon-e2e-kotlin test"`、`.gitignore` に `e2e/kotlin/generated/`、`**/build/`、`**/.gradle/`、`.kotlin/` を追加する。

### 依存してよいもの

`runtimes/kotlin` の main と生成 SDK: `ktor-client-core`、`kotlinx-serialization-json`（と Kotlin stdlib）。テスト（`runtimes/kotlin` の test、`e2e/kotlin`）: Tech Stack に挙げたもの。`packages/archon` の依存は増やさない。

---

## Task 1: Kotlin runtime — scaffold / spec 型 / エラー / パラメータ直列化

**Files:**
- Create: `runtimes/kotlin/{settings.gradle.kts,build.gradle.kts,gradle.properties,gradlew,gradlew.bat,gradle/wrapper/*}`, `runtimes/kotlin/src/main/kotlin/archon/runtime/{Specs,ApiHeaders,Errors,PercentEncoding,ParameterSerializer,RequestValues,ApiJson}.kt`, `runtimes/kotlin/src/test/kotlin/archon/runtime/{ParameterSerializerTest,ErrorsTest,ForbiddenApisTest}.kt`
- Modify: `.gitignore`

**Interfaces:**
- Produces（すべて `package archon.runtime`、explicit API）:
  ```kotlin
  public enum class ParamLocation { Path, Query, Header, Cookie }
  public enum class ParamStyle { Simple, Label, Matrix, Form, SpaceDelimited, PipeDelimited, DeepObject }
  public data class ParamSpec(val name: String, val location: ParamLocation, val style: ParamStyle, val explode: Boolean, val allowReserved: Boolean = false)
  public enum class BodyKind { Json, Form, Multipart, Text, Binary }
  public enum class ResponseKind { Json, Text, Binary, Empty }
  public enum class ApiKeyLocation { Header, Query, Cookie }
  public sealed interface SecuritySchemeSpec {
    public data object HttpBearer : SecuritySchemeSpec; public data object HttpBasic : SecuritySchemeSpec
    public data class ApiKey(val location: ApiKeyLocation, val name: String) : SecuritySchemeSpec
    public data class OAuth2(val tokenUrl: String? = null, val refreshUrl: String? = null) : SecuritySchemeSpec
    public data object OpenIdConnect : SecuritySchemeSpec }
  public data class SecurityScheme(val name: String, val scopes: List<String>)
  public data class SecurityRequirement(val schemes: List<SecurityScheme>)          // 空 = 任意認証
  public data class OperationSpec(val operationName: String, val method: io.ktor.http.HttpMethod, val path: String, val tags: List<String>,
    val security: List<SecurityRequirement>, val params: List<ParamSpec>, val body: BodyKind?, val bodyMediaType: String?,
    val responses: Map<String, ResponseKind>)                                          // キー '200' | '2XX' | 'default'
  public class ApiHeaders : Iterable<Pair<String, String>> {                          // 大文字小文字無視、挿入順、1 名 1 値
    constructor(); constructor(initial: Map<String, String>)
    operator fun set(name: String, value: String); operator fun get(name: String): String?; fun contains(name: String): Boolean
    fun remove(name: String): Boolean; val size: Int; fun copy(): ApiHeaders }
  public open class ApiException(val statusCode: Int, val headers: ApiHeaders, val rawBody: String?, val url: String, val body: Any? = null, message: String? = null) : RuntimeException
  public inline fun <reified T> ApiException.bodyAs(): T?
  public class ApiTransportException(message: String, cause: Throwable? = null, val timedOut: Boolean = false) : RuntimeException
  public class ApiDecodeException(val statusCode: Int, val rawBody: String, message: String, cause: Throwable? = null) : RuntimeException
  public class ApiAuthException(val schemes: List<String>, message: String, cause: Throwable? = null) : RuntimeException
  internal object PercentEncoding { fun component(s: String): String; fun reserved(s: String): String; fun form(s: String): String }
  public val ApiJson: kotlinx.serialization.json.Json        // ignoreUnknownKeys = true, encodeDefaults = false, explicitNulls = true
  public class RequestValues {
    fun <T> path(name: String, value: T, serializer: KSerializer<T>): RequestValues   // query / header / cookie も同形
    internal fun get(location: ParamLocation, name: String): JsonElement? }
  internal object ParameterSerializer {
    fun serializePath(template: String, specs: List<ParamSpec>, values: RequestValues): String
    fun serializeQuery(specs: List<ParamSpec>, values: RequestValues): String          // '?' なし、空なら ''
    fun serializeHeader(spec: ParamSpec, value: JsonElement): String?
    fun serializeCookie(specs: List<ParamSpec>, values: RequestValues): String? }      // 'a=1; b=2'
  ```
  値は `ApiJson.encodeToJsonElement(serializer, value)` で `JsonElement` にしてから M2 Task 2 と同じ規則で直列化する（JsonNull は出力しない。文字列は `content`、数値・真偽はリテラルのまま、配列は要素、object はキー順）。エンコード・不正値（空 / `.` / `..` セグメント、header の CR / LF、必須 path の欠落）の扱いも M2 Task 2 と同じで、例外は `IllegalArgumentException`。孤立サロゲートは U+FFFD として UTF-8 化する。
  Gradle: `settings.gradle.kts`（`rootProject.name = "archon-runtime"`）、`build.gradle.kts`（Global Constraints の JVM / explicitApi 設定、`allWarningsAsErrors = true`、`tasks.test { useJUnitPlatform() }`、依存は Tech Stack どおり）、`gradle.properties`（`org.gradle.jvmargs=-Xmx2g`、`kotlin.code.style=official`）。wrapper は Gradle 9.8.1 の bin 配布を scratchpad に展開して `gradle wrapper --gradle-version 9.8.1 --distribution-type bin` で作り、`distributionSha256Sum` を `gradle-wrapper.properties` に入れる。

- [ ] **Step 1:** 失敗するテストを書く。
  - `ParameterSerializerTest`: M1 Task 13 の表（値 `blue` / `listOf("blue","black","brown")` / `mapOf("R" to 100, "G" to 200, "B" to 150)`）を全行、パラメータ化テスト（`@ParameterizedTest` + `@MethodSource`）で検証する。追加: `percentEncodesReservedCharsInPathValues`（`/files/{name}` + `a/b?c#d e` → `/files/a%2Fb%3Fc%23d%20e`、`日本` → `%E6%97%A5%E6%9C%AC`）、`allowReservedKeepsReservedCharsInQuery`（`a/b?c:d` → `reserved=a/b?c:d`）、`keepsEncodeUriComponentSafeChars`（`!'()*~`）、`skipsNullValues`、`serializeCookieJoinsWithSemicolonSpace`、`rejectsDotSegmentPathValue`、`rejectsCrLfInHeader`、`formEncodingMatchesUrlSearchParams`（`a b&c` → `a+b%26c`、`*-._` はそのまま）、`encodesLoneSurrogateAsReplacementChar`（`"\uD800"` → `%EF%BF%BD`）。
  - `ErrorsTest`: `apiExceptionExposesStatusBodyAndRaw`（`bodyAs<String>()` が body を返し、別の型なら `null`）。
  - `ForbiddenApisTest`: `src/main/kotlin` の全 `.kt` に `java.time`、`java.util.Base64`、`java.net.http`、`CompletableFuture` が現れない。
- [ ] **Step 2:** `runtimes/kotlin/gradlew -p runtimes/kotlin test` → コンパイルエラー（型未定義）。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS（警告ゼロ）。
- [ ] **Step 5:** Commit `feat(runtime-kt): add Gradle project, spec types, errors and parameter serialization`。

## Task 2: Kotlin runtime — body / transport / client core / middleware chain

**Files:**
- Create: `runtimes/kotlin/src/main/kotlin/archon/runtime/{ApiBody,ApiFile,ApiRequest,ApiResponse,ApiResult,Decoders,Middleware,Transport,ClientOptions,ApiClientCore,Auth}.kt`（`Auth.kt` はこのタスクでは何もしない `AuthMiddleware` スタブ）
- Test: `runtimes/kotlin/src/test/kotlin/archon/runtime/{TestServer,BodyTest,TransportTest,ClientCoreTest}.kt`

**Interfaces:**
- Consumes: Task 1 の型。
- Produces:
  ```kotlin
  public class ApiRequest(var method: HttpMethod, var url: String, val headers: ApiHeaders, var body: ApiBody?) {
    val replayable: Boolean                                      // body?.replayable ?: true
    fun setQueryParameter(name: String, value: String) }         // 生の query を編集（他パラメータのバイトを保つ）
  public class ApiResponse(val statusCode: Int, val headers: ApiHeaders, val url: String, val body: ByteArray)   // body は読み込み済み
  public class ApiResult<out T>(val statusCode: Int, val headers: ApiHeaders, val url: String, val data: T)
  public abstract class ApiBody { abstract val replayable: Boolean; abstract val contentType: String?; abstract fun content(): OutgoingContent }
  public class BytesBody(bytes: ByteArray, contentType: String?) : ApiBody
  public class ChannelBody(channel: ByteReadChannel, contentType: String?) : ApiBody          // replayable = false
  public class FormBody : ApiBody { companion object { fun fromJson(obj: JsonObject): FormBody }; fun add(name: String, value: String): FormBody }
  public class MultipartBody : ApiBody { fun addText(name: String, value: String?): MultipartBody
    fun <T> addJson(name: String, value: T, serializer: KSerializer<T>): MultipartBody      // JSON 文字列は引用符なしの生テキスト、null は省略
    fun addFile(name: String, file: ApiFile?): MultipartBody; fun addFiles(name: String, files: List<ApiFile>?): MultipartBody }
  @Serializable(with = ApiFile.Serializer::class)                 // JSON 内では base64 文字列
  public class ApiFile(val content: ByteArray, val fileName: String? = null, val contentType: String? = null) { public object Serializer : KSerializer<ApiFile> }
  public fun interface ResponseDecoder<out T> { fun decode(statusCode: Int, body: ByteArray): T
    companion object { fun <T> json(serializer: KSerializer<T>): ResponseDecoder<T>; val text: ResponseDecoder<String>; val binary: ResponseDecoder<ByteArray>; val empty: ResponseDecoder<Unit> } }
  public class ErrorDecoders { fun json(status: String, serializer: KSerializer<*>): ErrorDecoders; fun text(status: String): ErrorDecoders; companion object { val None: ErrorDecoders } }
  public fun interface Middleware { suspend fun intercept(request: ApiRequest, next: suspend (ApiRequest) -> ApiResponse, context: CallContext): ApiResponse }
  public class CallContext(val operationName: String, val method: HttpMethod, val pathTemplate: String, val tags: List<String>,
    val security: List<SecurityRequirement>, var attempt: Int, val redactHeaders: Set<String>, val redactQuery: Set<String>,
    val extensions: MutableMap<String, Any?>)
  public fun interface AuthConfig { fun get(scheme: String): Any? }   // 生成 ApiAuth が実装（Task 3 の値型を返す）
  public open class ClientOptions { var baseUrl: String; val headers: MutableMap<String, String>; var timeout: Duration?
    val middleware: MutableList<Middleware>; var httpClient: HttpClient?; var customAuth: (suspend (ApiRequest, CallContext) -> Unit)?
    open val authConfig: AuthConfig? }
  public class RequestOptions(val headers: MutableMap<String, String> = linkedMapOf(), val extensions: MutableMap<String, Any?> = linkedMapOf(), var baseUrl: String? = null)
  public class ApiClientCore(val options: ClientOptions, val securitySchemes: Map<String, SecuritySchemeSpec>) : AutoCloseable {
    fun use(middleware: Middleware)
    suspend fun <T> send(operation: OperationSpec, values: RequestValues, decoder: ResponseDecoder<T>, errors: ErrorDecoders, requestOptions: RequestOptions?): ApiResult<T>
    override fun close() }
  ```
  `RequestValues` に body 用の `fun <T> jsonBody(value: T, serializer: KSerializer<T>)`、`fun <T> formBody(value: T, serializer: KSerializer<T>)`、`fun body(body: ApiBody)`、`fun textBody(value: String)`、`fun binaryBody(file: ApiFile)` を追加する（Task 1 の型を拡張）。

挙動（M2 Task 3 と同じ規則を Kotlin に写す。差分のみ記す）:
- HTTP クライアント: `options.httpClient` があれば `it.config { followRedirects = false; expectSuccess = false; useDefaultTransformers = false }`、無ければ `HttpClient { 同じ設定 }`（engine は ServiceLoader で classpath から。見つからなければ Ktor の例外をそのまま）。どちらも初回送信時に遅延生成して保持する。`close()` は自分で作ったクライアントだけを閉じ、派生クライアントは閉じても利用者の engine を閉じない（`config` の仕様）。
- Ktor への変換: URL は生の文字列をそのまま使い（再エンコードされないことを TestServer で確認する。`URLBuilder.takeFrom` で書き換わる engine があれば `encodedPath` / `encodedParameters` を直接設定する）、`Content-Type` と `Content-Length` はヘッダではなく `OutgoingContent` に載せる（Ktor はヘッダでの指定を拒否する）。応答 body は `bodyAsBytes()` で全量読む。
- タイムアウト: `withTimeout(options.timeout)` で送信からヘッダ受信までを覆い、`TimeoutCancellationException` を `ApiTransportException(timedOut = true)` に変える。呼び出し側のキャンセル（外側の Job の cancel）は `CancellationException` のまま伝える。`IOException`（Ktor の接続失敗を含む）は `ApiTransportException`。
- 成功時は `decoder` で body を読む。`ResponseDecoder.json` は 204 / 205 / 304 / 空 body のとき、`serializer.descriptor.isNullable` なら `null`、そうでなければ `ApiDecodeException`。`SerializationException` / `IllegalArgumentException` は `ApiDecodeException`（生テキスト保持）。非 2xx は `errors` を `status` → `NXX` → `default` の順で引き、JSON をデコードできれば `ApiException(body = 値)`、できなければ / 空なら `body = null` の `ApiException`、text なら `body = 文字列`。
- body: JSON は `ApiJson.encodeToString` の UTF-8 + `Content-Type: <mediaType>`（charset を足さない）、Text は UTF-8、Form は `FormBody`（配列は繰り返しキー、object は JSON 文字列、null は省略、`PercentEncoding.form`）、Multipart は自前で bytes を組み立てる（インスタンスごとに固定の boundary、`Content-Disposition: form-data; name="…"; filename="…"`、ファイル部の `Content-Type` は `contentType ?: application/octet-stream`、`filename*` は付けない）、Binary は `ApiFile.content` を `contentType ?: <mediaType>` で。
- リダイレクト・ヘッダ順・URL 結合・`Accept`・チェーン構成（`[...options.middleware のスナップショット, AuthMiddleware]`、terminal は transport、`attempt` は 1 から）・`use` の同期は M2 Task 3 と同じ。

- [ ] **Step 1:** 失敗するテストを書く。`TestServer` は `java.net.ServerSocket` で HTTP/1.1 を最小実装し、生のリクエスト行・ヘッダ・body を記録して、テストごとの応答を返す（2 つ起動すれば別オリジン）。engine を使うテストは `CIO` / `OkHttp` / `Android` の 3 engine でパラメータ化する（Android engine が JVM で動かない場合だけ外し、その旨をコミットメッセージに書く）。
  - body: `encodesJsonWithExactContentType`、`encodesFormWithRepeatedArrayFields`（`name=a+b%26c&count=2&tags=x&tags=y`）、`encodesMultipartWithQuotedNamesAndFilenames`、`channelBodyIsNotReplayable`、`multipartBodyCanBeSentTwice`、`apiFileSerializesAsBase64`。
  - client core:
    - `buildsUrlPreservingBaseUrlPath`: `http://127.0.0.1:{port}/api/` + `/foo/{id}` + `id=1` → リクエスト行 `GET /api/foo/1 HTTP/1.1`。
    - `sendsPipeBracketsAndEscapesUnchanged`（engine 別）: query `piped=1|2&filter[a]=b&x=%41`、path `/files/a%2Fb` がリクエスト行にそのまま出る（Review Focus）。
    - `returnsTypedDataOn2xx`、`throwsApiExceptionWithParsedBodyOn404`、`throwsApiExceptionWithNullBodyWhenErrorIsNotJson`、`returnsNullFor204WhenTypeIsNullable`、`throwsDecodeExceptionFor204WhenTypeIsNotNullable`、`throwsDecodeExceptionOnInvalidJson`。
    - `throwsTransportExceptionOnConnectionRefused`、`timeoutThrowsTransportExceptionWithTimedOut`、`callerCancellationPropagatesCancellationException`（`launch` した送信を `cancel()` → `CancellationException`、`ApiTransportException` ではない。Review Focus）。
    - `runsMiddlewareOuterToInnerWithAuthInnermost`: 記録順 `["mw1:before","mw2:before","auth","mw2:after","mw1:after"]`。`useAppendsMiddleware`。
  - transport（engine 別）: `manualRedirectStripsCredentialsOnCrossOriginHop`（`X-API-Key` / `Authorization` / `Cookie` / `api_key` クエリが 2 つ目のオリジンに届かない）、`sameOriginRedirectKeepsHeaders`、`seeOtherConvertsPostToGet`、`userHttpClientIsUsedEvenWithFollowRedirectsAndExpectSuccess`（`followRedirects = true` / `expectSuccess = true` / `install(DefaultRequest)` 付きで渡しても、302 は手動で追われ資格情報が除去され、404 は `ApiException` になる）、`closeDoesNotCloseUserClient`（`ApiClientCore.close()` 後も利用者の `HttpClient` で送信できる。Review Focus）。
- [ ] **Step 2:** `runtimes/kotlin/gradlew -p runtimes/kotlin test` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(runtime-kt): add client core, transport, body codec and middleware chain`。

## Task 3: Kotlin runtime — 認証 / OAuth2 トークンマネージャ

**Files:**
- Create: `runtimes/kotlin/src/main/kotlin/archon/runtime/OAuth2TokenManager.kt`
- Modify: `runtimes/kotlin/src/main/kotlin/archon/runtime/Auth.kt`（スタブを置き換える）
- Test: `runtimes/kotlin/src/test/kotlin/archon/runtime/{AuthTest,OAuth2TokenManagerTest}.kt`

**Interfaces:**
- Consumes: `ClientOptions`, `AuthConfig`, `SecuritySchemeSpec`, `SecurityRequirement`, `Middleware`, `ApiAuthException`
- Produces:
  ```kotlin
  public class TokenValue(provider: suspend () -> String) { constructor(token: String); suspend fun get(): String }
  public data class BasicCredentials(val username: String, val password: String)
  public class BasicValue(provider: suspend () -> BasicCredentials) { constructor(username: String, password: String); suspend fun get(): BasicCredentials }
  public enum class OAuth2ClientAuth { Basic, Post }
  public class OAuth2ClientCredentials(val clientId: String, val clientSecret: String, val scopes: List<String> = emptyList(), val tokenUrl: String? = null, val clientAuth: OAuth2ClientAuth = OAuth2ClientAuth.Basic)
  public class OAuth2RefreshToken(val refreshToken: String, val clientId: String, val clientSecret: String? = null, val tokenUrl: String? = null,
    val clientAuth: OAuth2ClientAuth = OAuth2ClientAuth.Basic, val onRefreshed: (suspend (TokenSet) -> Unit)? = null)
  public class OAuth2Value(val accessToken: TokenValue? = null, val clientCredentials: OAuth2ClientCredentials? = null, val refreshToken: OAuth2RefreshToken? = null)
  public data class TokenSet(val accessToken: String, val refreshToken: String?, val expiresAtMillis: Long?, val scope: String?)
  internal sealed interface Selection { data class Apply(val requirement: SecurityRequirement); data object Anonymous; data class Missing(val schemes: List<String>) }
  internal object SecuritySelector { fun select(requirements: List<SecurityRequirement>, isConfigured: (String) -> Boolean): Selection }
  public class OAuth2TokenManager(http: HttpClient, config: OAuth2Value, tokenUrl: String?, baseUrl: String?, scheme: String,
    nowMillis: () -> Long = { System.currentTimeMillis() }, leewayMillis: Long = 30_000, timeout: Duration? = null) {
    suspend fun getToken(scopes: List<String>): String; fun invalidate(rejectedToken: String? = null); val managed: Boolean }
  internal class AuthMiddleware(core: ApiClientCore) : Middleware
  ```
  規則は M2 Task 4 と同じ（selection、bearer / basic（UTF-8 → `kotlin.io.encoding.Base64`）/ apiKey（header / `setQueryParameter` / Cookie に追記）/ oauth2・openIdConnect（`accessToken` 優先、無ければ manager）、`customAuth` を最後に呼ぶ、securitySchemes に無いスキームは `customAuth` があれば設定済み扱い、`Missing` は送信前に `ApiAuthException`、manager はスキームごとに作り `authConfig` / `baseUrl` の参照が変わったら作り直す、管理トークンで 401 かつ replayable なら `invalidate(token)` して 1 回だけ再送）。トークン応答は `ApiJson` で `JsonObject` として読む。
  single-flight: `Mutex` 下の `MutableMap<String, Deferred<TokenSet>>`。取得は manager が持つ `CoroutineScope(SupervisorJob())` で `async` し（呼び出し側の Job から切り離す。`timeout` は `withTimeout` で掛ける）、各呼び出し側は `await()` する（1 人のキャンセルが他を巻き込まない）。完了・失敗した Deferred は map から外す。

- [ ] **Step 1:** 失敗するテストを書く（token endpoint は `MockEngine`。時刻は可変の `var now`）。
  - selector: `[]` → Anonymous、`[[bearer],[]]` で未設定 → Anonymous、`[[bearer]]` で未設定 → Missing `["bearer"]`、AND の一部だけ設定 → 次の代替へ。
  - auth: `appliesBearerFromSuspendProvider`、`appliesBasicWithUtf8`（`user:päss` → `Basic dXNlcjpww6Rzcw==`）、`appliesApiKeyInHeaderQueryCookie`、`throwsAuthExceptionBeforeSending`（MockEngine が呼ばれない）、`reappliesFreshTokenOnReentry`、`retriesOnceOn401WithManagedToken`、`customAuthCoversUnknownScheme`。
  - oauth2: `fetchesClientCredentialsWithBasicClientAuth`、`cachesUntil30sBeforeExpiry`、`singleFlightForConcurrentCalls`（5 並行で token endpoint 1 回）、`cancelledWaiterDoesNotCancelSharedFetch`（token endpoint を `CompletableDeferred` で止め、5 並行のうち 1 つの Job を cancel → その呼び出しだけ `CancellationException`、残り 4 つは同じトークンで成功、発行 1 回。Review Focus）、`refreshGrantRotatesTokenAndCallsOnRefreshed`、`resolvesRelativeTokenUrlAgainstBaseUrl`、`authExceptionOnTokenEndpointFailure`（非 2xx / JSON 不正 / `access_token` 無し）。
- [ ] **Step 2:** `runtimes/kotlin/gradlew -p runtimes/kotlin test` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(runtime-kt): add auth application and OAuth2 token manager`。

## Task 4: Kotlin runtime — 標準 middleware

**Files:**
- Create: `runtimes/kotlin/src/main/kotlin/archon/runtime/StandardMiddleware.kt`
- Test: `runtimes/kotlin/src/test/kotlin/archon/runtime/StandardMiddlewareTest.kt`

**Interfaces:**
- Produces:
  ```kotlin
  public class LoggingMiddleware(val log: (String) -> Unit = ::println, val includeHeaders: Boolean = false,
    val redactHeaders: Set<String> = emptySet(), val redactQuery: Set<String> = emptySet(), val nowMillis: () -> Long = { System.currentTimeMillis() }) : Middleware
  public class UserAgentMiddleware(val value: String) : Middleware
  public class RetryMiddleware(val maxAttempts: Int = 3, val baseDelay: Duration = 200.milliseconds, val maxDelay: Duration = 5.seconds,
    val maxRetryAfter: Duration = 60.seconds, val statuses: Set<Int> = setOf(408, 429, 500, 502, 503, 504),
    val methods: Set<HttpMethod> = setOf(Get, Head, Options, Put, Delete), val retryOnNetworkError: Boolean = true,
    val delay: suspend (Duration) -> Unit = { kotlinx.coroutines.delay(it) }, val random: () -> Double = { kotlin.random.Random.nextDouble() },
    val nowMillis: () -> Long = { System.currentTimeMillis() }) : Middleware
  public class Retry401Middleware(val onUnauthorized: suspend (CallContext, ApiResponse) -> Boolean) : Middleware
  ```
  挙動は M2 Task 5 と同じ（equal jitter `min(maxDelay, baseDelay * 2^(attempt-1)) * (0.5 + random()/2)`、429 / 503 の `Retry-After` 秒数・HTTP-date（RFC 1123 を自前で解析。`java.time` は使わない）を `maxRetryAfter` で上限、replayable でなければ再送しない、再送ごとに `attempt++`、タイムアウトの `ApiTransportException` と `CancellationException` は再送しない）。logging の行形式・マスク対象も M2 Task 5 と同じ（`→ {METHOD} {マスク済み URL}`、`includeHeaders` で `  {name}: {value}`、最後に `← {status} ({ms}ms)`、値は `***`）。

- [ ] **Step 1:** 失敗するテストを書く: `retries503WithRetryAfterSeconds`（delay に 1 秒）、`retries429WithRetryAfterHttpDate`、`doesNotRetryPostByDefault`、`doesNotRetryNonReplayable`、`stopsAfterMaxAttempts`、`retriesNetworkErrorsButNotTimeouts`、`equalJitterBounds`、`retry401RetriesOnceWithFreshAuth`（Task 3 の bearer provider と組み合わせて新トークン）、`loggingMasksAuthorizationCookieAndApiKeyQuery`、`userAgentSetsHeader`。
- [ ] **Step 2:** テスト実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** ランタイムの全テストが PASS。
- [ ] **Step 5:** Commit `feat(runtime-kt): add logging, user-agent, retry and retry401 middleware`。

## Task 5: Kotlin plugin — 名前・型対応・モデル

**Files:**
- Create: `packages/archon/src/plugins/kotlin/{index,reserved,names,emit,types,models,runtime}.ts`
- Modify: `packages/archon/src/plugins.ts`（`kotlin` と型を export）, `packages/archon/scripts/copy-runtimes.mjs`
- Test: `packages/archon/test/plugins/kotlin/{helpers,names,types,models,runtime}.test.ts`

**Interfaces:**
- Consumes: `definePlugin`, `CodeWriter`, `toCase`, `applyTemplate`, `UniqueNamer`, `resolveRuntimeDir`, IR、`hoistInlineUnions`。C# プラグインの `NamingRule` 型（`plugins/csharp/index.ts`）を再利用する。
- Produces:
  ```ts
  interface KotlinPluginOptions {
    output: string;                    // 既定 'kotlin'
    packageName: string | undefined;   // 既定: info.title を '.' 区切りの各部分を英数字だけの小文字に（'Archon Edge Cases' → 'archonedgecases'、空なら 'api'）
    clientName: string;                // 既定 'ApiClient'
    package: false | { group?: string; name?: string; version?: string; description?: string; dependencies?: string[] } | undefined;
    naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };
      // 既定 type PascalCase / method camelCase / property camelCase / file = 型名
    typeMappings: Record<string, string | { type: string; serializer: string }>;   // 文字列なら serializer は `<type>.serializer()`
    hooks: { typeName?; methodName?: (op) => string | undefined; propertyName?: (name: string, ctx: { schema: string }) => string | undefined;
             fileName?: (typeName: string) => string | undefined; typeOverride?: (schema, ctx: { path }) => string | { type: string; serializer: string } | undefined };
    include?: string[]; exclude?: string[];
  }
  interface KotlinPluginAPI { symbols: {
    typeOf(schemaName: string): { name: string; packageName: string; file: string };
    operation(operationId: string): { service: string; property: string; method: string; withResponseMethod: string; file: string } } }
  const kotlin: (options?: DeepPartial<KotlinPluginOptions>) => ArchonPlugin<KotlinPluginOptions, KotlinPluginAPI>;
  // names.ts
  type KtNames = { types: Map<string, string>; members(schemaName: string): Map<string, string> /* wire → Kotlin（必要ならバッククォート付き） */ };
  buildNames(ir: IRDocument, opts: KotlinPluginOptions, reserved: Iterable<string>): KtNames;
  ktIdentifier(raw: string, c: NameCase): string;   // 先頭数字は '_'、空は '_'
  escapeKeyword(id: string): string;                // ハードキーワードはバッククォート
  resolvePackageName(ir: IRDocument, opts: KotlinPluginOptions): string;
  // emit.ts
  ktFile(ctx, packageName: string, imports: string[]): CodeWriter;   // 4 スペース、ヘッダ、@file:Suppress / @file:OptIn、package、import
  kdoc(w: CodeWriter, text: string | undefined): void;              // '*/' と '/*' を壊す（Kotlin のブロックコメントは入れ子になる）
  literal(value: string): string;                                     // Kotlin 文字列リテラル（\ " $ 改行 等をエスケープ）
  // types.ts
  type KtType = { code: string; serializer: string; friendly: string };
  class KtTypeResolver { constructor(ir, names, opts, diagnostics, packageName); typeOf(schema: IRSchema, path: SchemaPath): KtType;
    isNullable(schema: IRSchema): boolean; nullable(t: KtType): KtType /* code + '?'、serializer + '.nullable' */ }
  // models.ts
  renderModels(ctx, names, resolver): { path: string; content: string }[];   // path: 'src/main/kotlin/<pkg>/models/<File>.kt'
  // runtime.ts
  readKtRuntime(srcDir: string): RuntimeFile[];               // src/main/kotlin/archon/runtime/*.kt を名前順
  rewritePackage(source: string, packageName: string): string;   // 'archon.runtime' → '<packageName>.core'
  runtimeTypeNames(files: RuntimeFile[]): Set<string>;        // public / internal な class / interface / object / typealias 名
  ```
  `irRequirements`: `{ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }`。ランタイムは `resolveRuntimeDir('kotlin', { marker: 'main/kotlin/archon/runtime/ApiClientCore.kt' })`（返るのは `runtimes/kotlin/src`）。copy-runtimes は kotlin の `src/test`、および全言語の `build/` / `.gradle/` を除外する。
  型対応（`hooks.typeOverride` → `typeMappings['kind:format']` → `typeMappings['kind']` の順）: string → `String`（format に関係なく）、integer → `Int`（`int64` → `Long`）、number → `Double`（`float` → `Float`）、boolean → `Boolean`、binary → `ApiFile`、unknown / null / tuple / 平坦化されなかった intersection → `JsonElement`、array → `List<T>`（`ListSerializer(…)`）、プロパティを持たない object → `Map<String, T>`（additionalProperties が無ければ `JsonElement`。`MapSerializer(String.serializer(), …)`）、const → 値の型（String / Long / Double / Boolean）。named schema のうち object（プロパティあり）/ enum / union だけが型を宣言し、それ以外は参照先を展開する（循環すれば `JsonElement`）。
  生成ファイルの共通形: 生成ヘッダ、`@file:Suppress("DEPRECATION", "RedundantVisibilityModifier")`、必要なら `@file:OptIn(ExperimentalSerializationApi::class)`、`package <pkg>.models`、明示 import（`kotlinx.serialization.*` の使うもの、`<pkg>.core.ApiFile` 等。star import は `<pkg>.models` 以外に使わない）。宣言はすべて明示 `public`。
  モデル出力（1 schema 1 ファイル）:
  - object → `@Serializable public data class X(…)`。各プロパティに `@SerialName("wire")`、required は既定値なし、optional は `T? = null`、required + nullable は `T?`（既定値なし）。description は KDoc、deprecated は `@Deprecated("Deprecated in the API.")`。判別あり union のバリアントで、その union の判別プロパティがちょうど 1 つのタグにマップされるものは、そのプロパティを `@EncodeDefault` + 既定値（タグ。型が拡張 enum なら `X("tag")`）にする。属する union の sealed interface を `: Pet, Shape` で実装する。
  - enum → 拡張 enum クラス（「意図的な差分」参照）: `value`（string → `String`、integer → `Long`、number → `Double`）、companion の既知値（メンバー名は値の PascalCase、数字始まりは `_`、空文字は `Empty`。`Serializer` / `value` / `isKnown` / `knownValues` / `Companion` と衝突すれば接尾辞）、`isKnown`、`knownValues: List<X>`、`equals` / `hashCode` / `toString`（`value.toString()`）、入れ子の `public object Serializer : KSerializer<X>`（`PrimitiveSerialDescriptor("<fqn>", STRING / LONG / DOUBLE)`）。
  - union → `@Serializable(with = X.Serializer::class) public sealed interface X`。入れ子に `public data class Unknown(val raw: JsonElement) : X`、ラッパーバリアント（名前は `<型の friendly>` + `Value`、配列は `<要素>List`、map は `<値>Map`。`Unknown` / `Serializer` / `X` と衝突すれば UniqueNamer）、`public object Serializer : KSerializer<X>`（descriptor は `SerialDescriptor("<fqn>", JsonElement.serializer().descriptor)`）。union ファイル内のモデル型参照はすべて完全修飾（`<pkg>.models.Cat`）にする（入れ子名がモデル名を隠すため）。判別なしの循環（`U1 = U2 | string`、`U2 = U1 | int`）は M2 の `wrapperVariants` と同じ規則でラッパーを展開する。同じ Kotlin 型のバリアントは 1 つにまとめる。`JsonDecoder` / `JsonEncoder` 以外で使われたら `SerializationException`。
  名前の予約: 型名（case-sensitive の UniqueNamer。ファイル名は case-insensitive で衝突を避ける）は `runtimeTypeNames`、`<clientName>`、`<clientName>Options`、`ApiAuth`、サービス名、Kotlin の既定 import で生成コードが使う型（`Any Boolean Byte ByteArray Char Double Float Int List Long Map Nothing Number Short String Unit Deprecated Suppress OptIn`）、生成コードが import する kotlinx 名（`Serializable SerialName EncodeDefault KSerializer Json JsonElement JsonObject JsonPrimitive JsonArray JsonNull JsonDecoder JsonEncoder SerialDescriptor PrimitiveSerialDescriptor PrimitiveKind Encoder Decoder SerializationException ExperimentalSerializationApi ListSerializer MapSerializer`）と衝突させない。プロパティ名は data class 内で UniqueNamer、`class` は `classValue`（JVM getter `getClass` と衝突するため）、ハードキーワード（`as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while`）はバッククォート。

- [ ] **Step 1:** 失敗するテストを書く（`helpers.ts` で小さな IR とプラグイン ctx を組み、出力文字列を `toContain` / 完全一致で比較する）。
  - names: `sanitizes type and member names`: schema `Foo.Bar` → `FooBar`、`1Thing` → `_1Thing`、`foo-bar` → `FooBar2`、`ApiRequest` → `ApiRequest2`、`String` → `String2`、`Serializable` → `Serializable2`、プロパティ `x-foo` → `xFoo`、`2fa` → `_2fa`、`foo_bar` と `fooBar` → `fooBar` / `fooBar2`、`when` → `` `when` ``、`class` → `classValue`（Review Focus）。`resolvePackageName` の既定と `packageName` 指定。
  - emit: `kdoc breaks comment delimiters`（`a */ b /* c` が KDoc を閉じも入れ子にもしない）、`literal escapes dollar, quotes and newlines`（`"$x\n"` → `"\"\$x\\n\""` 相当）。
  - types: `maps formats and nullability`（date-time / uuid / int64 / float / binary / unknown、optional → `?` と `.nullable`）、`expands non-object named schemas`、`falls back to JsonElement on alias cycles`、`applies typeMappings with and without serializer and typeOverride`。
  - models:
    - `renders required, optional and nullable properties with SerialName`: `@SerialName("name") public val name: String,` と `@SerialName("note") public val note: String? = null,`。
    - `renders self-referencing schema by name`: `public val children: List<Node>`（Review Focus）。
    - `renders extensible enum class with known values and serializer`（`Status.Active`、`isKnown`、integer enum `Priority._1` の `Long` 値）。
    - `renders discriminated union as sealed interface implemented by variants with an EncodeDefault tag`（`data class Circle(… public val kind: String = "circle", …) : Shape`、`Square` の `kind: SquareKind = SquareKind("square")`、`"circle" -> …Circle.serializer()` の分岐と `Unknown`）。
    - `lets one object implement two unions`（`: Pet, Mixed`）。
    - `renders untagged union trying variants in order with wrappers for primitives`（`Pet` は `Cat` / `Dog`、`string | Cat` は `StringValue` ラッパー）。
    - `flattens cyclic untagged unions`（U1 / U2 の Serializer が互いの Serializer を呼ばない。Review Focus）。
    - `fully qualifies model types inside union files`（モデル `Unknown` をバリアントに持つ union が `<pkg>.models.Unknown` を参照する。Review Focus）。
    - `marks deprecated schemas and suppresses deprecation warnings per file`。
  - runtime: `reads runtime files and rewrites the package`、`runtimeTypeNames lists public and internal runtime types`、`skips test sources`。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/plugins/kotlin` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-kt): emit Kotlin models, unions and extensible enums`。

## Task 6: Kotlin plugin — サービス / ApiClient / ApiAuth / Gradle ファイル / ランタイムのコピー

**Files:**
- Create: `packages/archon/src/plugins/kotlin/{services,client,project}.ts`
- Modify: `packages/archon/src/plugins/kotlin/index.ts`
- Test: `packages/archon/test/plugins/kotlin/{services,client,versions}.test.ts`

**Interfaces:**
- Consumes: Task 1–4 のランタイム公開 API（名前を文字列で埋め込む）、Task 5 の `KtNames` / `KtTypeResolver`。C# の `selectOperations` / `defaultBaseUrl` と同じ規則（共有したければ `plugins/csharp` から import してよい。C# の出力は変えない）。
- Produces（生成物の構造。E2E とカスタムプラグインが依存する）:
  ```
  <outputDir>/
    build.gradle.kts, settings.gradle.kts          # package !== false のとき
    src/main/kotlin/<pkg path>/
      <ClientName>.kt                              # <ClientName>, <ClientName>Options
      ApiAuth.kt
      models/*.kt                                  # Task 5
      services/<Group>Service.kt
      core/*.kt                                    # runtimes/kotlin/src/main/kotlin/archon/runtime/*.kt のコピー（package 書き換え済み）
  ```
  サービス（group ごと、無ければ `Default`。クラス `<PascalGroup>Service`、client のプロパティ `<camelGroup>`）:
  ```kotlin
  public class EchoService internal constructor(private val core: ApiClientCore) {
      /** … */
      public suspend fun echoPathStyles(simple: List<String>, …, requestOptions: RequestOptions? = null): Echo =
          echoPathStylesWithResponse(simple, …, requestOptions).data

      public suspend fun echoPathStylesWithResponse(simple: List<String>, …, requestOptions: RequestOptions? = null): ApiResult<Echo> {
          val values = RequestValues()
              .path("simple", simple, ListSerializer(String.serializer()))
          return core.send(ECHO_PATH_STYLES, values, ResponseDecoder.json(Echo.serializer()), ECHO_PATH_STYLES_ERRORS, requestOptions)
      }

      private companion object {
          val ECHO_PATH_STYLES = OperationSpec(…)
          val ECHO_PATH_STYLES_ERRORS = ErrorDecoders().json("401", Error.serializer())
      }
  }
  ```
  - 引数順は M2 Task 7 と同じ（path → 必須 body → 必須 query / header / cookie → optional body → optional → `requestOptions: RequestOptions? = null`）。optional は `T? = null`。名前は camelCase + キーワードはバッククォート、衝突は UniqueNamer（`requestOptions` / `values` / `body` / `core` を予約）。KDoc に `@param`（IRParameter.description、無ければ schema.description）。
  - 成功型: 最小ステータスの 2xx（無ければ `2XX`）。content 無しなら `Unit` / `ApiResult<Unit>` と `ResponseDecoder.empty`。json → `ResponseDecoder.json(<serializer>)`（型は schema の nullable に従う）、text / form / multipart → `ResponseDecoder.text`、binary → `ResponseDecoder.binary`（`ByteArray`）。
  - エラー: 非 2xx の各レスポンスで json → `.json(status, serializer)`、text → `.text(status)`。
  - body: json → `.jsonBody(body, serializer)`、form → `.formBody(body, serializer)`、multipart → `.body(MultipartBody().addJson("title", body.title, …).addFile("file", body.file).addFiles("attachments", body.attachments))`（`ApiFile` / `List<ApiFile>` のプロパティは addFile / addFiles）、text → `.textBody(body)`、binary → `.binaryBody(body)`（引数型 `ApiFile`）。form / multipart の schema が object でなければ引数型をランタイムの `FormBody` / `MultipartBody` にして `.body(body)`。optional body は `if (body != null)`。GET / HEAD の body は warn `request-body-ignored` で出力しない。
  - include / exclude を通らない操作は出力しない（モデルは出力する）。deprecated の操作は `@Deprecated`。HTTP メソッドは `HttpMethod.Get` 等（TRACE は `HttpMethod("TRACE")`）。
  クライアント:
  ```kotlin
  public class ApiClient(public val options: ApiClientOptions = ApiClientOptions()) : AutoCloseable {
      public constructor(configure: ApiClientOptions.() -> Unit) : this(ApiClientOptions().apply(configure))
      public val core: ApiClientCore = ApiClientCore(options, SECURITY_SCHEMES)
      public val echo: EchoService = EchoService(core)
      public fun use(middleware: Middleware): ApiClient
      override fun close()
      public companion object { public const val DEFAULT_BASE_URL: String = "http://localhost:4010"; public val SECURITY_SCHEMES: Map<String, SecuritySchemeSpec> }
  }
  public class ApiClientOptions : ClientOptions() { init { baseUrl = ApiClient.DEFAULT_BASE_URL }; public var auth: ApiAuth? = null; override val authConfig: AuthConfig? get() = auth }
  public class ApiAuth(public var bearerAuth: TokenValue? = null, public var basicAuth: BasicValue? = null, public var oauth2: OAuth2Value? = null, …) : AuthConfig {
      override fun get(scheme: String): Any? = when (scheme) { "bearerAuth" -> bearerAuth; …; else -> null } }
  ```
  スキーム → 値型・tokenUrl / refreshUrl の取り方・`DEFAULT_BASE_URL` の展開・http-other / mutualTLS を出さないことは M2 Task 7 と同じ。サービスのプロパティ名は `options` / `core` / `use` / `close` と衝突すれば `Value` 接尾辞。
  Gradle ファイル（`project.ts`。バージョン定数 `KOTLIN_VERSION = '2.4.21'`、`KTOR_VERSION = '3.6.0'`、`SERIALIZATION_VERSION = '1.11.0'` を export）: `settings.gradle.kts` は `rootProject.name = "<name>"`（既定 name は title の kebab-case、`archon-edge-cases`）と `repositories { mavenCentral() }` の pluginManagement / dependencyResolutionManagement。`build.gradle.kts` は `kotlin("jvm")` / `kotlin("plugin.serialization")` / `` `java-library` ``、`group`（既定 packageName）、`version`（既定 `info.version`）、`description`、依存 `api(ktor-client-core)` / `api(kotlinx-serialization-json)` + `package.dependencies` を `implementation(...)`、Global Constraints の JVM / explicitApi 設定。
  ランタイムのコピー: `readKtRuntime` → `rewritePackage` → 生成ヘッダを付けて `src/main/kotlin/<pkg path>/core/<file>` に emit。

- [ ] **Step 1:** 失敗するテストを書く。
  - services: `orders parameters path, required, optional, then requestOptions`、`renames colliding parameter names`（path `id` と query `id` → `id` / `id2`）、`escapes keyword parameter names`（`in` → `` `in` ``）、`emits OperationSpec with styles, security and responses`、`picks the lowest 2xx response type`、`returns Unit for no-content operations`、`keeps a nullable success type nullable`、`emits error decoders per status`、`encodes multipart files with addFile/addFiles`、`uses runtime FormBody for non-object form bodies`、`plugin include/exclude limits generated operations`、`uses methodName hook and naming.method template`。
  - client: `emits DEFAULT_BASE_URL with server variables expanded, SECURITY_SCHEMES and ApiAuth per scheme kind`、`names services after groups and avoids reserved member names`、`emits build.gradle.kts and settings.gradle.kts with package metadata and extra dependencies`、`package false skips Gradle files`、`copies the runtime under core with the package rewritten`。
  - versions: `runtime and e2e builds use the plugin's version constants`（`runtimes/kotlin/build.gradle.kts` に 3 つの定数が現れる。`e2e/kotlin/build.gradle.kts` は Task 8 で作るので、存在すればそれも検証する）。
  - index: `symbols.typeOf and symbols.operation return generated names`。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/plugins/kotlin` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-kt): emit services, client, auth, Gradle files and vendored runtime`。

## Task 7: スナップショットとコンパイルテスト

**Files:**
- Modify: `packages/archon/test/e2e-generate/snapshot.test.ts`
- Create: `packages/archon/test/e2e-generate/{kotlin-compile.test.ts,kotlin-warnings.init.gradle.kts}`, `packages/archon/test/e2e-generate/__snapshots__/kotlin/**`

**Interfaces:**
- Consumes: `generate()`、`kotlin()`、`fixtures/specs/{petstore.yaml,edge-cases.yaml,natsuneko.json}`、`runtimes/kotlin/gradlew`

- [ ] **Step 1:** 失敗するテストを書く。
  - snapshot: petstore と edge-cases を `kotlin({ output: '.' })` で生成し、info 以外の診断が無いこと、`core/` 以外の全ファイルを `__snapshots__/kotlin/<spec>/<file>` と比較すること。
  - compile（`java -version` が 17 以上でなければ `describe.skip`。逐次、各ケース timeout 600 秒）: 生成先で `<repo>/runtimes/kotlin/gradlew -p <dir> build --init-script kotlin-warnings.init.gradle.kts --console=plain` を実行し、終了コード 0 を assert する（失敗時は出力を表示）。init script は全 `KotlinCompile` に `compilerOptions.allWarningsAsErrors = true` を設定する。ケース:
    - stress（Review Focus）: C# の stress spec に、schema `String` / `List` / `Result` / `Unit` / `Any` / `ApiRequest` / `Serializable` / `Json` / `Unknown`、`Unknown` をバリアントに持つ union、プロパティ `class` / `when` / `x-foo` / `2fa`、description に `*/` `/*` `$name` を持つ schema、`Node.children` の自己参照を足したもの。
    - petstore、edge-cases、natsuneko（既定）、natsuneko（`packageName: 'com.natsuneko.api'`, `clientName: 'NatsunekoClient'`, `typeMappings: { integer: 'Long' }`）、natsuneko（`filters.schemas.include: ['/^Album/']`）。
- [ ] **Step 2:** `pnpm vitest run packages/archon/test/e2e-generate` → snapshot 作成 / compile 失敗を確認し、プラグインを直して通す。
- [ ] **Step 3:** snapshot を目視確認する（型名、`? = null`、`@SerialName`、KDoc、サービスの引数順、serializer 式、union の分岐）。`pnpm test` 全体が PASS。
- [ ] **Step 4:** Commit `test: add snapshot and gradle build tests for Kotlin output`。

## Task 8: Kotlin E2E

**Files:**
- Create: `e2e/kotlin/{package.json,scripts/run.mjs,scripts/generate.mjs,settings.gradle.kts,build.gradle.kts,src/test/kotlin/archon/e2e/*.kt}`
- Modify: root `package.json`（`test:e2e:kotlin`）、`.gitignore`

**Interfaces:**
- Consumes: `startMockServer()`（`e2e/mock-server`、変更しない）、`generate()`、生成 SDK（`e2e/kotlin/generated/EdgeCases`、package `archon.edgecases`、group `archon.e2e`、name `edge-cases`）
- Produces: `pnpm test:e2e:kotlin` — `run.mjs` が jiti でモックサーバと archon の src を読み込み、`generate({ input: 'fixtures/specs/edge-cases.yaml', output: 'e2e/kotlin/generated', plugins: [kotlin({ output: 'EdgeCases', packageName: 'archon.edgecases', package: { group: 'archon.e2e', name: 'edge-cases' } })] })` → `startMockServer()` → `runtimes/kotlin/gradlew -p e2e/kotlin test --console=plain -Parchon.e2e.baseUrl=<url> -Parchon.e2e.secondaryUrl=<url>` を stdio 継承で実行 → サーバを閉じ、gradle の終了コードで終了する。`build.gradle.kts` はその 2 つを test の system property に渡し、`outputs.upToDateWhen { false }`、`useJUnitPlatform()`、`ktor-client-cio` を testImplementation に持つ。`Support.kt` は system property、`client { … }` ヘルパー（`ApiClient { baseUrl = …; httpClient = shared CIO client }`）、`GET /__stats` の読み取りを提供する。テストは `runBlocking` で実時間を使う（JUnit 5 は既定で逐次）。

シナリオ（TS / C# E2E と同じ。期待値も同じで、Kotlin の差分は「常に例外」「空 JSON は `ApiDecodeException`」「日付は文字列」と型の違いだけ）:
- [ ] **Step 1:** テストを書く。
  - Params: `serializesAllPathStyles`（`/echo/path/a,b/.a.b/;x=1;y=2`）、`percentEncodesReservedCharacters`（`/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2`）、`serializesAllQueryStyles`（C# の `SerializesAllQueryStyles` と同じ文字列と完全一致）、`omitsUnsetQueryParameters`（`limit=1`）、`sendsHeaderArrayAndCookies`（`x-request-ids: a,b`、`cookie: theme=dark; tags=x,y`）。
  - Bodies: JSON（`contentType == "application/json"`、エコー body を `JsonPayload` として読み直して一致、`note = null` は送られない）、form（`name=a+b%26c&count=2&tags=x&tags=y`）、multipart（`files` が `[file data.bin 10, attachments a.txt 3, attachments b.txt 5]`、body が `{"title":"hello"}`）、binary（`content-length: 9`、`raw bytes`）、text、`createNode` の再帰ツリー（`WithResponse` で `statusCode == 201`、ids `n1`–`n4` と `parentId`）。
  - Responses: text `hello, archon`、binary 256 バイト（先頭 0x00、末尾 0xff）、204 は `statusCode == 204` で例外なし、空 JSON は `ApiDecodeException`（`statusCode == 200`、`rawBody == ""`）。
  - Unions: shapes の 3 要素が `Circle(radius = 1.0)` / `Square(side = 2.0)` / `Shape.Unknown`（`raw.jsonObject["kind"] == "hexagon"`、`side == 3`）、pets は `is Cat` / `is Dog` で判別、enums は `Status.Active`、`Priority._2`、`statuses[1].isKnown == false` かつ `value == "archived"`、`color == null`、`level.value == "unknown-level"`、dates は mock の返す文字列のまま（ネスト配列と `byKey` を含む）。
  - Auth: C# の `AuthTests` と同じ 14 シナリオ（bearer / basic / apiKey header・query（`query == "api_key=test-key"`、provider 経由）・cookie、誤った bearer は `ApiException`（401、`bodyAs<Error>()!!.code == 401`）、未設定は `ApiAuthException`（`schemes == listOf("bearerAuth")`）でサーバに届かない、optional の匿名 / bearer、AND、oauth2 clientCredentials で発行 +1、refresh grant で `onRefreshed` が新しい refresh token で 1 回、2.1 秒後の先回り更新（発行 +2、`/auth/oauth2` +2）、コールドクライアント 5 並行（`coroutineScope { List(5) { async { … } } }`）で発行 1 回かつ同一 Authorization）。
  - Middleware: retry で `fail=2` → `{ key, attempts: 3 }`、`maxAttempts = 2` で `ApiException`（503）、retry401 + トークン差し替えで成功（`onUnauthorized` が `attempt == 1` で 1 回）、logging のマスク（1 行目 `→ GET {baseUrl}/echo/headers?api_key=***`、ヘッダ行に `authorization: ***` / `x-api-key: ***` / `cookie: ***` / `x-request-ids: r1`、ログ全体に `test-token` / `test-key` / `dark` が無い、最終行 `← 200 (Nms)`）、userAgent、登録順（`x-trace == "a,b,c"`、順序 `>a >b >c <c <b <a`、`c` は `client.use`）。
  - Errors: 200 は `ok == true`、404 は `bodyAs<NotFoundError>()!!.resource == "errors/404"`、400 は `ValidationError`、418 / 500 は default の `Error`（`code == 418` / `500`）。
  - Redirect: `apiKeyHeader` + `requestOptions.headers["Authorization"]` を付けて `redirectCrossOrigin` → `WithResponse` の `url` が secondary のオリジン、エコーの `path == "/echo/headers"`、`x-api-key` / `authorization` が無い。
- [ ] **Step 2:** `pnpm test:e2e:kotlin` を実行し、失敗をランタイム / プラグインの修正で解消する（期待値は TS / C# と揃え、緩めない）。
- [ ] **Step 3:** ルートで `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:e2e:csharp`、`runtimes/kotlin/gradlew -p runtimes/kotlin test` がすべて通ることを確認する。
- [ ] **Step 4:** Commit `test: add Kotlin end-to-end suite against the mock server`。

## Task 9: CI・README・例

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `README.md`, `examples/natsuneko/archon.config.ts`

- [ ] **Step 1:** `ci.yml` に Kotlin の節を追加する（`actions/setup-java@v6` の `temurin` 17 と `gradle/actions/setup-gradle@v6`（キャッシュ）を使う）:
  - `runtime-kotlin`: `runtimes/kotlin/gradlew -p runtimes/kotlin test --console=plain`。
  - `e2e-kotlin`: setup-workspace + Java → `pnpm test:e2e:kotlin`。
  - 既存の `test` ジョブに Java 17 のセットアップを追加する（Kotlin のコンパイルテスト用）。`build` ジョブの tarball 検査の言語一覧に `kotlin` を足し、`runtimes/kotlin/src/test/`・`build/`・`.gradle/` が入っていないことも検査する。`ci-ok` の `needs` に 2 ジョブを足す。
- [ ] **Step 2:** `dependabot.yml` に `package-ecosystem: gradle`（`directories: ['/runtimes/kotlin', '/e2e/kotlin']`、weekly、1 グループ）を追加する。プラグインのバージョン定数は Task 6 の versions テストが一致を保証する旨をコメントで書く。
- [ ] **Step 3:** `examples/natsuneko/archon.config.ts` に `kotlin({ output: 'kotlin', packageName: 'com.natsuneko.api' })` を追加する。README に Kotlin の節を追加する: 生成物の構成、`ApiClient { baseUrl = …; httpClient = HttpClient(CIO); auth = ApiAuth(bearerAuth = TokenValue("…")) }`、engine の選び方（JVM: CIO / OkHttp、Android: OkHttp / Android）、`client.catalyst.getX(...)` と `WithResponse`、例外の種類と `bodyAs<T>()`、middleware（`Middleware` と標準 4 種、`client.use`）、OAuth2、渡した `HttpClient` の扱い（派生設定で `followRedirects = false` にすること、`close()` が閉じないこと）、拡張 enum と sealed union の使い方と「意図的な差分」、`gradlew` / `pnpm test:e2e:kotlin` の実行方法、ロードマップの M3 を完了にする。
- [ ] **Step 4:** push して CI の全ジョブ（`ci-ok`）が green であることを確認する。
- [ ] **Step 5:** Commit `ci: run the Kotlin runtime, compile and E2E tests` と `docs: document the Kotlin plugin and runtime`。
