# Archon M5（Rust）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust（stable、edition 2021）言語プラグインと、`reqwest` + `serde` + `serde_json` + `tokio` だけに依存する手書き Rust ランタイムを実装する。`edge-cases.yaml` と `natsuneko.json` から生成した Rust SDK が `cargo clippy`（警告ゼロ）を通り、TypeScript / C# / Kotlin と同じ E2E シナリオがモックサーバに対して通ることを完了条件とする。

**Architecture:** `runtimes/rust` を Cargo のライブラリ crate（`archon-runtime`、lib 名 `archon_runtime`）として置き、生成時に `src/*.rs` を出力先の `src/core/` へコピーする（`lib.rs` → `mod.rs`、`crate::` → `crate::core::` に書き換え）。Rust プラグイン（`packages/archon/src/plugins/rust`）は inline の object / enum / union を巻き上げた IR から、モデル（`src/models/*.rs`）、タグ別サービス（`src/services/*.rs`、操作ごとのリクエストビルダー + `IntoFuture`）、`ApiClient` / `ApiClientBuilder` / `ApiAuth`、`src/lib.rs`、`Cargo.toml` を出力する。E2E は既存の `e2e/mock-server` を Node スクリプトで起動し、生成 SDK を path 依存で取り込む `e2e/rust` の結合テストを `cargo test` で実行する。

**Tech Stack:** Rust 1.88+（edition 2021。`url` が依存する `icu_*` の要求。開発環境は 1.99）、reqwest 0.13.5（`default-features = false`、TLS は feature）、serde 1.0.229（`derive`）、serde_json 1.0.154（`preserve_order`）、tokio 1.54.1（`time` / `sync`）。テストのみ: tokio の `macros` / `rt-multi-thread`。既存の Node 24 / pnpm 10 / vitest / jiti。

**Spec:** `docs/superpowers/specs/2026-10-25-archon-design.md`（特に §6、§7 Rust 列と注記、§8、§10）。挙動の規則は M2 / M3 の各タスクと同じものを Rust に写し、ここでは差分だけを書く。

## Global Constraints

- 生成 Rust SDK とランタイムの依存は `reqwest`、`serde`、`serde_json`、`tokio` のみ。base64、乱数、HTTP-date、URL 文字列操作は自前で実装する（`base64` / `rand` / `chrono` / `futures` / `bytes` crate を使わない）。URL の解決とオリジン比較は reqwest が再エクスポートする `reqwest::Url` を使う。
- `reqwest` は `default-features = false`。生成 `Cargo.toml` の features: `default = ["rustls"]`、`rustls = ["reqwest/rustls"]`、`native-tls = ["reqwest/native-tls"]`（spec §7 注記の「TLS は feature で選択、rustls 既定」。reqwest 0.13 で feature 名が `rustls-tls` から `rustls` になった）。
- `tokio` は `time`（sleep / timeout）と `sync`（非同期 Mutex）のみ。spawn しない（ランタイムを持ち込まない）。
- 生成コードとランタイムは `cargo clippy --all-targets -- -D warnings` で警告ゼロ。ランタイムに unsafe は無い（`#![forbid(unsafe_code)]`）。
- 型対応（spec §7 Rust 列）: `date-time` / `date` / `uuid` / `uri` / `byte` → `String`、`int64` → `i64`、`int32` → `i32`、format なし integer → `i64`、`float` → `f32`、それ以外の number → `f64`、binary → `ApiFile`、nullable / optional → `Option<T>` + `#[serde(default, skip_serializing_if = "Option::is_none")]`（optional のみ）。
- 判別あり union → enum + 判別値でバリアントを選ぶ自前の `Deserialize`、判別なし union → `#[serde(untagged)]` enum、enum → 未知値を保持する `Unknown(…)` バリアント付き enum（spec §6.6）。
- 予約語は `r#`（spec §7）。`r#` にできない `self` / `Self` / `super` / `crate` と `_` は末尾 `_`。
- API 形状は `client.<group>().<method>(必須引数…)` が返すリクエストビルダーに任意引数を setter で積み、`.await`（`IntoFuture`）または `.send().await` で送る。結果は `Result<ApiResponse<T>, Error<E>>`（spec §7）。
- Middleware は spec §6.2 のとおり `trait Middleware: Send + Sync { fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>>; }`。登録順に外側から実行し、認証適用は最内側。
- 標準 middleware・認証・OAuth2・リダイレクト時の資格情報除去・再送可能リクエストの規則と既定値は TS / C# / Kotlin と同一。パラメータ直列化・エンコード結果は他ランタイムとバイト単位で一致させる（数値は JavaScript の `Number#toString` と同じ表記）。
- 生成物の各ファイル先頭には生成ヘッダ（`// ` コメント、`output.header` で上書き可。`Cargo.toml` は `# `）を付与する。
- バージョン定数はプラグインの `project.ts` に 1 か所だけ置き、`runtimes/rust/Cargo.toml` と `e2e/rust/Cargo.toml` の値と一致することをテストで保証する。

## Spec からの M5 における意図的な差分

- **multipart は reqwest の `multipart` ではなくランタイムが bytes を組み立てる**（ファイルは `ApiFile { content: Vec<u8>, file_name, content_type }`）。reqwest の `multipart::Form` はストリームで再送できない（リトライ・リダイレクト・401 再送で body を作り直せない）ため。JSON もランタイムが `serde_json` で直列化するので、reqwest の `json` / `multipart` feature は有効化しない。
- **`reqwest::Client` は再設定できないので、渡す Client は `redirect(Policy::none())` で作ってもらう**。ランタイムは常に自前でリダイレクトを追い（cross-origin で資格情報を除去）、既定の Client もそう作る。`archon_runtime::http_client_builder()`（= `reqwest::Client::builder().redirect(Policy::none())`）を公開し、README で案内する。リダイレクトを追う Client を渡すと、reqwest の既定動作（`Authorization` / `Cookie` は除去するが API Key ヘッダ・クエリは残る）になる。
- **URL は reqwest（WHATWG URL）が送信時に正規化する**。ランタイムが組み立てた URL のうち、WHATWG の query percent-encode set に入る `'` などは `%27` に変わる（TypeScript の `fetch` と同じ挙動）。`|` / `[` / `]` / `%41` / `%2F` はそのまま送られることをテストで保証する。
- **操作のエラーボディは操作ごとの enum**: `GetErrorError { Status400(ValidationError), Status404(NotFoundError), Default(Error) }`（範囲キーは `Status4xx`）。宣言が無い操作は `()`。`Error<E>` は `Api(ApiError<E>)` / `Transport(TransportError)` / `Decode(DecodeError)` / `Auth(AuthError)` / `InvalidRequest(InvalidRequestError)`（必須 path の欠落、CR/LF を含むヘッダ、絶対 URL でない base URL など。他言語の `IllegalArgumentException` 相当）。`ApiError::body` は該当ステータスの宣言型にデコードできたときだけ `Some`。
- **成功 JSON の戻り値型は schema の nullable に従い、空 body は `Option` でなければ `DecodeError`**（Kotlin と同じ）。
- **キャンセルは future の drop**（Rust の慣習）。タイムアウトは `TransportError { timed_out: true }`。OAuth2 トークン取得の single-flight は非同期 Mutex で行うので、取得中の呼び出し側が drop されると取得は中断され、待っていた次の呼び出し側が取得し直す（他の呼び出し側は失敗しない）。
- **設定は `ApiClient` の構築時に確定する**（`use_middleware` による middleware の追加だけは後からできる）。資格情報の差し替えは `TokenValue::provider` などのプロバイダで行う。
- **additionalProperties は `std::collections::HashMap<String, T>`**、プロパティと併せ持つ object の追加プロパティは保持しない（spec §6.6）。
- **自己参照する型**（`Node.parent: Node` のように `Vec` / `HashMap` を挟まない循環）は `Box<T>` で持つ。
- **date-time 等は `String`**。spec の opt `chrono` / `uuid` は専用オプションにせず、`typeMappings` と `package.dependencies` で利用者が差し替える。
- **`package: false` は `Cargo.toml` だけを出さない**（`src/lib.rs` は出す。生成コードは `crate::core` / `crate::models` を参照するため crate のルートでなければならない）。

## Review Focus

- **WHATWG による URL の再エンコード**（query `piped=1|2&filter[a]=b&x=%41`、path `/files/a%2Fb`）→ リクエスト行がランタイムの直列化結果と一致する。→ Task 2 の `TestServer` テスト。
- **Rust 識別子として不正・衝突する名前**（プロパティ `type` / `self` / `crate` / `x-foo` / `2fa` / `foo_bar` と `fooBar`、schema 名 `String` / `Vec` / `Option` / `Box` / `Result` / `Self` / `Value` / `Unknown`、union のバリアントになる schema `Unknown`、description 中の ```` ``` ```` とインデントされたコード）→ 正規化・接尾辞・`r#` で通り、doc コメントが doctest にならない。→ Task 5、Task 7（stress ケース）。
- **自己参照 / 相互参照する schema と union**（`Node.children: Vec<Node>`、`Node.parent: Node`、判別なし `U1 = U2 | string` と `U2 = U1 | int`）→ 型のサイズが有限（`Box`）で、untagged のデシリアライズが無限再帰しない（Kotlin と同じ平坦化）。→ Task 5、Task 7。
- **同時リクエスト**（コールドクライアントで 5 並行）→ トークン取得は 1 回。→ Task 3、Task 8。

---

## File Structure

```
packages/archon/
  scripts/copy-runtimes.mjs             # Task 5: rust の Cargo.toml / tests / target を除外（src のみコピーなので追加不要の確認）
  src/plugins.ts                        # Task 5: rust を export
  src/plugins/rust/
    index.ts        # definePlugin 本体・オプション・symbols API
    reserved.ts     # Rust キーワード、prelude 名
    names.ts        # 型名・フィールド名・モジュール名
    emit.ts         # rsFile（ヘッダ）、doc コメント、文字列リテラル
    types.ts        # IRSchema → Rust 型（RsTypeResolver）
    models.ts       # src/models/*.rs（struct / 拡張 enum / union）
    services.ts     # src/services/*.rs（サービス、リクエストビルダー、エラー enum）
    client.ts       # src/client.rs（ApiClient, ApiClientBuilder, SECURITY_SCHEMES）、src/auth.rs（ApiAuth）、src/lib.rs
    project.ts      # Cargo.toml、バージョン定数
    runtime.ts      # ランタイムの読み込みと書き換え
  test/plugins/rust/{helpers,names,types,models,services,client,runtime,versions}.test.ts
  test/e2e-generate/snapshot.test.ts    # Task 7: Rust を追加
  test/e2e-generate/rust-compile.test.ts   # Task 7
  test/e2e-generate/__snapshots__/rust/{petstore,edge-cases}/**

runtimes/rust/
  Cargo.toml
  src/{lib,specs,headers,errors,encoding,json_number,params,values,body,file,request,response,decode,
       middleware,url,transport,options,core,auth,oauth2,standard}.rs
  tests/*.rs                            # TestServer は std::net::TcpListener 製の最小 HTTP/1.1

e2e/rust/
  package.json                          # @natsuneko-laboratory/archon-e2e-rust（private）
  scripts/{run.mjs,generate.mjs}
  Cargo.toml                            # [dev-dependencies] archon-edge-cases = { path = "generated/EdgeCases" }
  src/lib.rs                            # 空（テスト専用 crate）
  tests/{support/mod.rs,params,bodies,responses,unions,auth,middleware,errors,redirect}.rs
```

ルート `package.json` に `"test:e2e:rust": "pnpm -F @natsuneko-laboratory/archon-e2e-rust test"`、`.gitignore` に `**/target/`、`e2e/rust/generated/` を追加する。

---

## Task 1: Rust runtime — crate / spec 型 / エラー / パラメータ直列化

**Files:**
- Create: `runtimes/rust/{Cargo.toml,src/{lib,specs,headers,errors,encoding,json_number,params,values}.rs}`, `runtimes/rust/tests/{params,errors,forbidden}.rs`
- Modify: `.gitignore`

**Interfaces（`archon_runtime` の公開 API）:**
```rust
pub enum ParamLocation { Path, Query, Header, Cookie }
pub enum ParamStyle { Simple, Label, Matrix, Form, SpaceDelimited, PipeDelimited, DeepObject }
pub struct ParamSpec { pub name: &'static str, pub location: ParamLocation, pub style: ParamStyle, pub explode: bool, pub allow_reserved: bool }
pub enum BodyKind { Json, Form, Multipart, Text, Binary }
pub enum ResponseKind { Json, Text, Binary, Empty }
pub enum ApiKeyLocation { Header, Query, Cookie }
pub enum SecuritySchemeSpec { HttpBearer, HttpBasic, ApiKey { location, name: &'static str }, OAuth2 { token_url: Option<&'static str>, refresh_url: Option<&'static str> }, OpenIdConnect }
pub struct SecurityScheme { pub name: &'static str, pub scopes: &'static [&'static str] }
pub struct SecurityRequirement { pub schemes: &'static [SecurityScheme] }          // 空 = 任意認証
pub struct OperationSpec { pub operation_name, pub method: reqwest::Method, pub path, pub tags: &'static [&'static str],
  pub security: &'static [SecurityRequirement], pub params: &'static [ParamSpec], pub body: Option<BodyKind>,
  pub body_media_type: Option<&'static str>, pub responses: &'static [(&'static str, ResponseKind)] }   // 生成コードの const
pub struct ApiHeaders;   // 大文字小文字無視、挿入順、1 名 1 値: new / get / set / remove / contains / iter / len
pub enum Error<E = ()> { Api(ApiError<E>), Transport(TransportError), Decode(DecodeError), Auth(AuthError), InvalidRequest(InvalidRequestError) }
pub struct ApiError<E> { pub status: u16, pub headers: ApiHeaders, pub url: String, pub raw_body: Vec<u8>, pub body: Option<E> }
pub struct TransportError { pub message: String, pub timed_out: bool, /* source */ }
pub struct DecodeError { pub status: u16, pub raw_body: String, pub message: String }
pub struct AuthError { pub schemes: Vec<String>, pub message: String }
pub struct InvalidRequestError { pub message: String }
pub struct RequestValues;  // path / query / header / cookie(name, &impl Serialize) -> Self（serde_json::Value に変換、null は未設定）
pub fn serialize_path(template, specs, values) -> Result<String, InvalidRequestError>   // #[doc(hidden)]
pub fn serialize_query(specs, values) -> String; pub fn serialize_header(spec, &Value) -> Result<Option<String>, _>; pub fn serialize_cookie(specs, values) -> Option<String>
```
`Error<E>` は `Display` と `std::error::Error`（`E: Debug`）を実装する。直列化の規則・不正値の扱いは M2 Task 2 / M3 Task 1 と同じ（数値は `json_number::format` で JavaScript と同じ表記、孤立サロゲートは Rust の文字列に存在しない）。ランタイムの単体テストは `tests/` に置く（`src` 内の `#[cfg(test)]` は生成 SDK にコピーされるため禁止。`forbidden.rs` で検査する）。

- [ ] **Step 1:** 失敗するテストを書く: M1 Task 13 の表を全行、`percent_encodes_reserved_chars_in_path_values`、`allow_reserved_keeps_reserved_chars_in_query`、`keeps_encode_uri_component_safe_chars`、`skips_null_values`、`serialize_cookie_joins_with_semicolon_space`、`rejects_dot_segment_path_value`、`rejects_cr_lf_in_header`、`form_encoding_matches_url_search_params`、`formats_numbers_like_javascript`（`1.0` → `1`、`1e21` → `1e+21`、`1e-7` → `1e-7`、`0.1` → `0.1`、`-0.0` → `0`）、`deep_object_keeps_declaration_order`。`forbidden.rs`: `src/` に `#[cfg(test)]`、`unsafe`、`base64`、`chrono`、`futures` が現れない。
- [ ] **Step 2:** `cargo test --manifest-path runtimes/rust/Cargo.toml` → コンパイルエラー。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS（`cargo clippy --all-targets -- -D warnings` も）。
- [ ] **Step 5:** Commit `feat(runtime-rs): add crate, spec types, errors and parameter serialization`。

## Task 2: Rust runtime — body / transport / client core / middleware chain

**Files:**
- Create: `runtimes/rust/src/{body,file,request,response,decode,middleware,url,transport,options,core,auth}.rs`（`auth.rs` は何もしない認証 middleware のスタブ）
- Test: `runtimes/rust/tests/{support/mod.rs,body,transport,client_core}.rs`

**Interfaces:**
```rust
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub struct ApiRequest { pub method: Method, pub url: String, pub headers: ApiHeaders, pub body: Option<ApiBody> }
  // replayable() / try_clone() / set_query_parameter(name, value)（他のパラメータのバイトを保つ）
pub enum ApiBody { Bytes(Vec<u8>), Stream(reqwest::Body) }        // Stream は再送不可
pub struct ApiResponse<T = Vec<u8>> { pub status: u16, pub headers: ApiHeaders, pub url: String, pub data: T }
pub struct ApiFile { pub content: Vec<u8>, pub file_name: Option<String>, pub content_type: Option<String> }  // JSON 内は base64
pub struct FormBody; pub struct MultipartBody;   // add_text / add_json / add_file / add_files、境界はインスタンスごとに固定
pub fn decode_json<T: DeserializeOwned>(status: u16, body: &[u8]) -> Result<T, DecodeError>;  // decode_text / decode_binary / decode_empty
pub trait ErrorBody: Sized { fn decode(status: u16, body: &[u8]) -> Option<Self>; }   // () は常に None
pub fn decode_error_json<T: DeserializeOwned>(body: &[u8]) -> Option<T>; pub fn decode_error_text(body: &[u8]) -> String;
pub trait Middleware: Send + Sync { fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>>; }
pub fn middleware_fn<F>(f: F) -> impl Middleware;   // for<'a> Fn(ApiRequest, &'a CallContext, Next<'a>) -> BoxFuture<'a, …>
#[derive(Clone, Copy)] pub struct Next<'a>; impl Next<'a> { pub fn run(self, req: ApiRequest) -> BoxFuture<'a, Result<ApiResponse, Error>> }
pub struct CallContext { pub operation_name, pub method, pub path_template, pub tags, pub security, pub redact_headers: Vec<String>, pub redact_query: Vec<String>, /* attempt: AtomicU32, extensions: Mutex<HashMap<String, Value>> */ }
  // attempt() / increment_attempt() / extension(key) / set_extension(key, value)
pub struct ClientOptions { pub base_url: String, pub headers: ApiHeaders, pub timeout: Option<Duration>, pub middleware: Vec<Arc<dyn Middleware>>,
  pub http_client: Option<reqwest::Client>, pub custom_auth: Option<Arc<dyn CustomAuth>>, pub auth: Option<Arc<dyn AuthConfig>> }
pub struct RequestOptions { pub headers: ApiHeaders, pub extensions: HashMap<String, Value>, pub base_url: Option<String> }  // builder 風 setter
pub struct ApiClientCore;  // new(options, security_schemes: &'static [(&'static str, SecuritySchemeSpec)]) / options() / use_middleware(m)
  // async fn send<T, E: ErrorBody>(&self, op: &'static OperationSpec, values: RequestValues, decode: fn(u16, &[u8]) -> Result<T, DecodeError>, options: RequestOptions) -> Result<ApiResponse<T>, Error<E>>
pub fn http_client_builder() -> reqwest::ClientBuilder;   // redirect(Policy::none())
```
`RequestValues` に body 用の `json_body(&impl Serialize)` / `form_body(&impl Serialize)` / `text_body(String)` / `binary_body(ApiFile)` / `multipart_body(MultipartBody)` / `body(ApiBody, content_type)` を追加する。挙動は M3 Task 2 と同じ（URL 結合、ヘッダ順、`Accept`、Content-Type、手動リダイレクトと資格情報の除去、303 / POST の GET 化、タイムアウトは最終応答のヘッダ受信までで body の読み込みは含まない、チェーンは `[...middleware のスナップショット, 認証]`、`attempt` は 1 から）。

- [ ] **Step 1:** 失敗するテストを書く（`TestServer` は `std::net::TcpListener` をスレッドで回す最小 HTTP/1.1。生のリクエスト行・ヘッダ・body を記録し、テストごとの応答を返す。2 つ起動すれば別オリジン）。
  - body: `encodes_json_with_exact_content_type`、`encodes_form_with_repeated_array_fields`、`encodes_multipart_with_quoted_names_and_filenames`、`stream_body_is_not_replayable`、`multipart_body_is_deterministic`、`api_file_serializes_as_base64`。
  - client core: `builds_url_preserving_base_url_path`、`sends_pipe_brackets_and_escapes_unchanged`、`returns_typed_data_on_2xx`、`api_error_with_typed_body_on_404`、`api_error_without_body_when_error_is_not_json`、`returns_none_for_204_when_type_is_option`、`decode_error_for_204_when_type_is_not_option`、`decode_error_on_invalid_json`、`transport_error_on_connection_refused`、`timeout_is_transport_error_with_timed_out`、`runs_middleware_outer_to_inner_with_auth_innermost`、`use_middleware_appends`、`invalid_base_url_is_invalid_request`。
  - transport: `manual_redirect_strips_credentials_on_cross_origin_hop`、`same_origin_redirect_keeps_headers`、`see_other_converts_post_to_get`、`non_replayable_body_returns_the_redirect`。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(runtime-rs): add client core, transport, body codec and middleware chain`。

## Task 3: Rust runtime — 認証 / OAuth2 トークンマネージャ

**Files:** Create `runtimes/rust/src/oauth2.rs`、Modify `runtimes/rust/src/auth.rs`、Test `runtimes/rust/tests/{auth,oauth2}.rs`

**Interfaces:**
```rust
pub struct TokenValue;    // new(token) / provider(|| async { … }) / try_provider(|| async { Ok(…) }) / get().await -> Result<String, AuthError>; From<&str>, From<String>
pub struct BasicCredentials { pub username: String, pub password: String }
pub struct BasicValue;    // new(user, pass) / provider / try_provider
pub enum OAuth2ClientAuth { Basic, Post }
pub struct OAuth2ClientCredentials { pub client_id, pub client_secret, pub scopes: Vec<String>, pub token_url: Option<String>, pub client_auth }
pub struct OAuth2RefreshToken { pub refresh_token, pub client_id, pub client_secret: Option<String>, pub token_url, pub client_auth, pub on_refreshed: Option<Arc<dyn Fn(&TokenSet) + Send + Sync>> }
pub struct OAuth2Value { pub access_token: Option<TokenValue>, pub client_credentials: Option<…>, pub refresh_token: Option<…> }
pub struct TokenSet { pub access_token: String, pub refresh_token: Option<String>, pub expires_at_millis: Option<u64>, pub scope: Option<String> }
pub enum AuthValue<'a> { Token(&'a TokenValue), Basic(&'a BasicValue), OAuth2(&'a OAuth2Value) }
pub trait AuthConfig: Send + Sync { fn get(&self, scheme: &str) -> Option<AuthValue<'_>>; }   // 生成 ApiAuth が実装
pub trait CustomAuth: Send + Sync { fn apply<'a>(&'a self, req: &'a mut ApiRequest, ctx: &'a CallContext) -> BoxFuture<'a, Result<(), Error>>; }  // 同期クロージャにも実装
pub struct OAuth2TokenManager;  // new(http, config, token_url, base_url, scheme) + with_clock / with_leeway / with_timeout; get_token(&scopes).await; invalidate(Option<&str>); managed()
```
規則は M3 Task 3 と同じ（selection、bearer / basic（UTF-8 → base64）/ apiKey（header / `set_query_parameter` / Cookie 追記）/ oauth2・openIdConnect（`access_token` 優先、無ければ manager）、`custom_auth` を最後に呼ぶ、spec に無いスキームは `custom_auth` があれば設定済み扱い、`Missing` は送信前に `AuthError`、manager はスキームごとに遅延作成、管理トークンで 401 かつ再送可能なら `invalidate(token)` して 1 回だけ再送）。single-flight はキーごとの `tokio::sync::Mutex`（取得後にキャッシュを再確認）。

- [ ] **Step 1:** 失敗するテストを書く（token endpoint は `TestServer`。時刻は差し替え可能な時計）: selector の 4 ケース、`applies_bearer_from_provider`、`applies_basic_with_utf8`（`user:päss` → `Basic dXNlcjpww6Rzcw==`）、`applies_api_key_in_header_query_cookie`、`auth_error_before_sending`、`reapplies_fresh_token_on_reentry`、`retries_once_on_401_with_managed_token`、`custom_auth_covers_unknown_scheme`、`fetches_client_credentials_with_basic_client_auth`、`caches_until_30s_before_expiry`、`single_flight_for_concurrent_calls`、`refresh_grant_rotates_token_and_calls_on_refreshed`、`resolves_relative_token_url_against_base_url`、`auth_error_on_token_endpoint_failure`。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(runtime-rs): add auth application and OAuth2 token manager`。

## Task 4: Rust runtime — 標準 middleware

**Files:** Create `runtimes/rust/src/standard.rs`、Test `runtimes/rust/tests/standard.rs`

**Interfaces:** `LoggingMiddleware::new(log: impl Fn(&str))`（`include_headers` / `redact_header` / `redact_query`）、`UserAgentMiddleware::new(value)`、`RetryMiddleware::default()`（`max_attempts` 3 / `base_delay` 200ms / `max_delay` 5s / `max_retry_after` 60s / statuses / methods / `retry_on_network_error`、`with_sleep` / `with_random` / `with_clock` を差し替え可能）、`Retry401Middleware::new(|ctx, res| Box::pin(async move { … }))`。挙動・ログ形式は M3 Task 4 と同じ。乱数は `RandomState` のハッシュから作る。

- [ ] **Step 1:** 失敗するテスト: `retries_503_with_retry_after_seconds`、`retries_429_with_retry_after_http_date`、`does_not_retry_post_by_default`、`does_not_retry_non_replayable`、`stops_after_max_attempts`、`retries_network_errors_but_not_timeouts`、`equal_jitter_bounds`、`retry401_retries_once_with_fresh_auth`、`logging_masks_authorization_cookie_and_api_key_query`、`user_agent_sets_header`。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(runtime-rs): add logging, user-agent, retry and retry401 middleware`。

## Task 5: Rust plugin — 名前・型対応・モデル

**Files:** Create `packages/archon/src/plugins/rust/{index,reserved,names,emit,types,models,runtime}.ts`、Modify `packages/archon/src/plugins.ts`、Test `packages/archon/test/plugins/rust/{helpers,names,types,models,runtime}.test.ts`

**Interfaces:**
```ts
interface RustPluginOptions {
  output: string;                    // 既定 'rust'
  clientName: string;                // 既定 'ApiClient'
  package: false | { name?: string; version?: string; description?: string; license?: string; authors?: string[]; repository?: string; dependencies?: string[] } | undefined;
    // name 既定: title の kebab-case（'archon-edge-cases'）。version は semver でなければ '0.1.0'（警告）。dependencies は [dependencies] にそのまま書く行
  naming: { type?: NamingRule; method?: NamingRule; property?: NamingRule; file?: NamingRule };   // 既定 PascalCase / snake_case / snake_case / snake_case(型名)
  typeMappings: Record<string, string>;   // 'kind:format' / 'kind' → Rust 型
  hooks: { typeName?; methodName?; propertyName?; fileName?; typeOverride?: (schema, ctx) => string | undefined };
  include?: string[]; exclude?: string[];
}
interface RustPluginAPI { symbols: {
  typeOf(schemaName): { name: string; path: string /* crate::models::X */; file: string };
  operation(operationId): { service: string; accessor: string; method: string; builder: string; error: string | undefined; module: string; file: string } } }
```
`irRequirements`: `{ hoistInlineObjects: true, hoistInlineEnums: true, hoistInlineUnions: true }`。ランタイムは `resolveRuntimeDir('rust', { marker: 'core.rs' })`。
型名は UniqueNamer（prelude の型・トレイト名、`Self`、`ApiClient` / `ApiClientBuilder` / `ApiAuth` を予約）、モジュール名（ファイル名）は snake_case で型名とも衝突しないように確保する。フィールドは struct 内で UniqueNamer、キーワードは `r#`。
モデル出力（1 schema 1 ファイル、`src/models/mod.rs` が `mod x; pub use self::x::X;`）:
- object → `#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]`（全フィールドが既定値を持てるなら `Default` も）の struct。ワイヤ名と違えば `#[serde(rename = "…")]`、optional は `Option<T>` + `default` + `skip_serializing_if`、required + nullable は `Option<T>`。他モデルは `super::X`、循環は `Box<…>`。description は `///`（コードフェンスは `text` を付け、フェンス外の行頭空白は除く）、deprecated は `#[deprecated]`。
- enum → `Unknown(String | i64 | f64)` 付きの enum、`as_str()` / `value()`、`is_known()`、`KNOWN_VALUES`、値で比較する `PartialEq`（文字列・整数は `Eq` / `Hash` も）、`From`、`Display`、手書きの `Serialize` / `Deserialize`。バリアント名は値の PascalCase（数字始まりは `Value` 接頭辞、空文字は `Empty`、`Unknown` は予約）。
- union → 判別ありは enum + 判別値で選ぶ `Deserialize`（`serde_json::Value` 経由、未知は `Unknown(Value)`）と各バリアントをそのまま書く `Serialize`。判別なしは `#[serde(untagged)]` enum の末尾に `Unknown(serde_json::Value)`。バリアント名はモデル名、プリミティブ等は `String` / `Integer` / `Number` / `Boolean` / `<要素>List` / `<値>Map` / `Json` / `File`。判別なしの循環は Kotlin と同じ規則で展開する。

- [ ] **Step 1:** 失敗するテスト（Kotlin のテストと同じ観点を Rust に写す）: names（`Foo.Bar` → `FooBar`、`1Thing` → `_1Thing`、`String` → `String2`、`type` → `r#type`、`self` → `self_`、`x-foo` → `x_foo`、`2fa` → `_2fa`、`foo_bar` / `fooBar` → `foo_bar` / `foo_bar2`）、emit（doc のコードフェンス、文字列リテラル）、types（format と nullability、typeMappings / typeOverride、エイリアス循環は `serde_json::Value`）、models（required / optional / nullable、rename、自己参照の `Vec<super::Node>`、直接の循環の `Box`、拡張 enum、判別あり / なし union、循環する untagged union の平坦化、deprecated）、runtime（`crate::` の書き換え、`lib.rs` → `mod.rs`）。
- [ ] **Step 2〜4:** `pnpm vitest run packages/archon/test/plugins/rust` で FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(plugin-rs): emit Rust models, unions and extensible enums`。

## Task 6: Rust plugin — サービス / ApiClient / ApiAuth / lib.rs / Cargo.toml / ランタイムのコピー

**Files:** Create `packages/archon/src/plugins/rust/{services,client,project}.ts`、Modify `index.ts`、Test `packages/archon/test/plugins/rust/{services,client,versions}.test.ts`

生成物:
```
<outputDir>/
  Cargo.toml                       # package !== false のとき
  src/lib.rs                       # pub mod core; pub mod models; pub mod services; pub use client::{…}; pub use auth::ApiAuth;
  src/client.rs  src/auth.rs
  src/models/{mod.rs,*.rs}
  src/services/{mod.rs,<group>.rs}
  src/core/{mod.rs,*.rs}           # ランタイムのコピー
```
サービス（group ごと、無ければ `Default`。モジュール `services::<snake_group>`、構造体 `<PascalGroup>Service`、client のアクセサ `<snake_group>()`）:
```rust
#[derive(Clone)]
pub struct EchoService { core: Arc<core::ApiClientCore> }
impl EchoService {
    /// Echo a JSON body
    pub fn echo_json(&self, body: impl Into<models::JsonPayload>) -> EchoJsonRequest { … }
}
#[must_use = "a request does nothing until it is awaited"]
pub struct EchoJsonRequest { core: Arc<core::ApiClientCore>, body: models::JsonPayload, options: core::RequestOptions }
impl EchoJsonRequest {
    pub fn request_options(mut self, options: core::RequestOptions) -> Self
    pub async fn send(self) -> Result<core::ApiResponse<models::Echo>, core::Error> { … self.core.send(&ECHO_JSON, values, core::decode_json, self.options).await }
}
impl IntoFuture for EchoJsonRequest { type IntoFuture = core::BoxFuture<'static, Self::Output>; … }
const ECHO_JSON: core::OperationSpec = core::OperationSpec { … };
```
- 必須引数（path → 必須 body → 必須 query / header / cookie）は `impl Into<T>`、任意引数は同名の setter（`impl Into<T>`）。名前の衝突は UniqueNamer（`send` / `request_options` / `into_future` / `core` / `options` / `new` を予約）。
- 成功型・デコーダ・body の扱い・GET / HEAD の body 無視（warn）・include / exclude・deprecated（`#[deprecated]`）は M3 Task 6 と同じ。form / multipart の schema が object でなければ引数型はランタイムの `FormBody` / `MultipartBody`。
- エラー型: 非 2xx に content があれば `<Op>Error` enum（`ErrorBody` を実装。完全一致 → 範囲 → default の順に match）、無ければ `()`。
クライアント:
```rust
#[derive(Clone)] pub struct ApiClient { core: Arc<core::ApiClientCore> }
impl ApiClient { pub const DEFAULT_BASE_URL: &'static str; pub fn new() -> Self; pub fn builder() -> ApiClientBuilder; pub fn from_options(core::ClientOptions) -> Self;
  pub fn core(&self) -> &Arc<core::ApiClientCore>; pub fn echo(&self) -> services::EchoService; pub fn use_middleware(&self, m: impl core::Middleware + 'static) -> &Self }
pub struct ApiClientBuilder;  // base_url / header / timeout / middleware / http_client / custom_auth / auth(ApiAuth) / build()
#[derive(Clone, Debug, Default)] pub struct ApiAuth { pub bearer_auth: Option<core::TokenValue>, … }   // impl core::AuthConfig
```
`Cargo.toml`（`project.ts`。`REQWEST_VERSION = '0.13.5'`、`SERDE_VERSION = '1.0.229'`、`SERDE_JSON_VERSION = '1.0.154'`、`TOKIO_VERSION = '1.54.1'`、`RUST_VERSION = '1.88'` を export）。

- [ ] **Step 1:** 失敗するテスト: services（引数順、衝突、キーワード、OperationSpec、最小 2xx、no-content は `()`、nullable 成功型、エラー enum と match 順、multipart の add_file / add_files、非 object form、include / exclude、methodName hook）、client（DEFAULT_BASE_URL、SECURITY_SCHEMES、ApiAuth、アクセサ名の予約、Cargo.toml のメタデータと追加依存、`package: false`、ランタイムのコピー）、versions、symbols。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS。
- [ ] **Step 5:** Commit `feat(plugin-rs): emit services, client, auth, Cargo manifest and vendored runtime`。

## Task 7: スナップショットとコンパイルテスト

- [ ] **Step 1:** snapshot: petstore / edge-cases を `rust({ output: '.' })` で生成し、`src/core/` 以外を `__snapshots__/rust/<spec>/<file>` と比較。compile（`cargo --version` が無ければ skip。逐次、各ケース 600 秒）: 生成先で `cargo clippy --all-targets --no-default-features -- -D warnings`（`CARGO_TARGET_DIR` を全ケースで共有）。ケース: stress（Review Focus）、petstore、edge-cases（既定 features でも 1 回）、natsuneko（既定）、natsuneko（`clientName: 'NatsunekoClient'`, `typeMappings: { integer: 'i32' }`）、natsuneko（`filters.schemas.include: ['/^Album/']`）。
- [ ] **Step 2〜3:** 直して通す。snapshot を目視確認。`pnpm test` 全体が PASS。
- [ ] **Step 4:** Commit `test: add snapshot and cargo clippy tests for Rust output`。

## Task 8: Rust E2E

`pnpm test:e2e:rust` — `run.mjs` が SDK を `e2e/rust/generated/EdgeCases` に生成（`package: { name: 'archon-edge-cases' }`）→ `startMockServer()` → `cargo test --manifest-path e2e/rust/Cargo.toml -- --test-threads=1`（環境変数 `ARCHON_E2E_BASE_URL` / `ARCHON_E2E_SECONDARY_URL`）→ サーバを閉じて終了コードを返す。シナリオは Kotlin の E2E と同じ（Params / Bodies / Responses / Unions / Auth 14 / Middleware / Errors / Redirect。Rust の差分は「戻り値は `ApiResponse<T>`」「エラーは `Error::Api(ApiError { body: Some(GetErrorError::Status404(…)) })`」「空 JSON は `Error::Decode`」「並行は `tokio::spawn`」）。

- [ ] **Step 1:** テストを書く。**Step 2:** `pnpm test:e2e:rust` を通す（期待値は他言語と揃え、緩めない）。**Step 3:** `pnpm test` / `pnpm typecheck` / ランタイムのテストが通ることを確認。**Step 4:** Commit `test: add Rust end-to-end suite against the mock server`。

## Task 9: CI・README・例

- [ ] `ci.yml` に `runtime-rust`（`dtolnay/rust-toolchain@stable` + clippy、`Swatinem/rust-cache`、`cargo test` と `cargo clippy --all-targets -- -D warnings`）と `e2e-rust` を追加し、`test` ジョブに Rust ツールチェーン（コンパイルテスト用）、`build` ジョブの tarball 検査に `rust`（`runtimes/rust/` に `tests/`・`target/`・`Cargo.toml` が入らないこと）、`ci-ok` の `needs` に 2 ジョブを足す。
- [ ] `dependabot.yml` に `package-ecosystem: cargo`（`/runtimes/rust`、`/e2e/rust`）。
- [ ] `examples/natsuneko/archon.config.ts` に `rust({ output: 'rust' })`。README に Rust の節（生成物の構成、`ApiClient::builder()`、ビルダーと `.await`、`ApiResponse` と `Error<E>`、middleware と標準 4 種、OAuth2、渡す `reqwest::Client` は `http_client_builder()` で作ること、TLS feature、拡張 enum と union、意図的な差分、`pnpm test:e2e:rust`）を追加し、ロードマップの M5 を完了にする。
- [ ] Commit `ci: run the Rust runtime, compile and E2E tests` と `docs: document the Rust plugin and runtime`。
