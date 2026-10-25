# Archon

OpenAPI 3.0 / 3.1 の仕様から、**外部依存を最小化した** SDK を生成するジェネレータ（Meta SDK）です。
設計の詳細は [`docs/superpowers/specs/2026-10-25-archon-design.md`](docs/superpowers/specs/2026-10-25-archon-design.md) を参照してください。

現在は **M1（コア + TypeScript プラグイン）** まで実装済みです。生成される TypeScript SDK は実行時依存ゼロ（`fetch` のみ）で、
ランタイムは生成物の `core/` にそのままコピーされます。

## インストール

npm にはまだ公開していません。当面はこのリポジトリのワークスペースで開発・利用します（Node.js 24 / pnpm 10）。

```sh
pnpm install
pnpm -F archon build   # CLI (packages/archon/dist/cli.js) を作る
```

公開後は `pnpm add -D archon` で利用する想定です。

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

ワークスペース内では、`examples/natsuneko` のように `archon` を devDependency に持つパッケージから `pnpm exec archon generate` で実行できます。

```sh
cd examples/natsuneko && pnpm exec archon generate   # → examples/natsuneko/sdk/ts/
```

### 設定ファイル

`archon.config.ts`（ローダーは jiti）。配列を `defineConfig([a, b])` に渡すと複数ジョブになります。

```ts
import { defineConfig } from 'archon';
import { typescript } from 'archon/plugins';

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
| `dates` | `'string'` | `'Date'` にすると応答の日時を `Date` に変換する（`transformers.gen.ts`） |
| `importExtension` | `'.js'` | 生成コードの相対 import の拡張子（`'.ts'` / `''` も可） |
| `naming` | PascalCase / camelCase | `{ type, method }` ごとに `{ case, name }` |
| `typeMappings` | `{}` | `'string:uuid': 'Uuid'` のような `kind:format` → TS 型式の上書き |
| `hooks` | `{}` | `typeName` / `methodName` / `typeOverride` |
| `include` / `exclude` | なし | プラグイン単位の操作フィルタ（`parser.filters` と同じ構文） |

## 生成された SDK の使い方

`ts/` の下に `types.gen.ts` / `sdk.gen.ts` / `client.gen.ts` / `index.ts` / `core/`（ランタイム）が出力されます。
操作は `method` + パスの camelCase 名の関数になります（例: `GET /catalyst/v1/status/{id}` → `getCatalystV1StatusById`）。
パスパラメータ・クエリ・ボディはそれぞれ `path` / `query` / `body` で渡します。

```ts
import { createApiClient, getCatalystV1Announcements, getCatalystV1StatusById } from './sdk/ts/index.js';

// baseUrl の既定は spec の servers[0]
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
- OAuth2 トークンは期限の 30 秒前に先回りで更新され、同時更新は 1 回にまとめられ、401 を受けたら 1 回だけ強制更新して再送します。相対の `tokenUrl` は `baseUrl` に対して解決されます。
- `http` の bearer / basic 以外や `mutualTLS` は生成時に警告となり、`createApiClient({ customAuth: (req, ctx) => { ... } })` で対応します。

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

既定では例外を投げず `{ data, error, response }` を返します（`throwOnError: true` で例外）。

| クラス | 内容 |
|---|---|
| `ApiError` | 非 2xx。`status` / `body`（型付きエラーボディ）/ `response` |
| `TransportError` | 通信失敗・タイムアウト・キャンセル。`timedOut` / `cause` |
| `DecodeError` | 応答のデシリアライズ失敗。`raw`（生 body）/ `response` |
| `AuthError` | 必須認証が未設定。`schemes` |

### 対応ランタイム

Browser / Node.js 18+ / Bun / Deno / React Native / Cloudflare Workers（ESM のみ）。グローバルの `fetch` / `Request` / `Response` /
`Headers` / `URL` / `FormData` / `Blob` / `AbortController` だけを使います。`createApiClient({ fetch })` で `fetch` を差し替えられます。
利用側の tsconfig は `strict: true`, `target: ES2022`, `lib: ["ES2022", "DOM"]`, `module: "NodeNext"` を想定しています。

## カスタムプラグイン

`definePlugin` で作ります。依存プラグイン（ここでは `typescript`）の公開 API `symbols` から、生成済みの型名・関数名を参照できます。

```ts
import { defineConfig, definePlugin } from 'archon';
import { typescript } from 'archon/plugins';
import type { TypeScriptPluginAPI } from 'archon/plugins';

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
| M2 | C#（.NET 10） | 未着手 |
| M3 | Kotlin（JVM 11+ / Android） | 未着手 |
| M4 | Swift 6 | 未着手 |
| M5 | Rust | 未着手 |
| M6 | Go 1.22+ | 未着手 |

M1 の TypeScript プラグインでは `bigint`（int64）オプション、`naming.property` / `hooks.propertyName` / `naming.file` / `hooks.fileName` は提供していません。

## 開発

```sh
pnpm test        # 単体・スナップショット・生成物のコンパイルテスト（vitest）
pnpm typecheck   # 全パッケージの tsc --noEmit
pnpm test:e2e    # モックサーバに対して生成 SDK を実行する E2E（e2e/typescript）
pnpm build       # 全パッケージのビルド
```

### ライブスモーク（手動）

`api.natsuneko.com` に対し、認証不要・必須パラメータ無しの GET を 3 件、生成 SDK で実際に呼びます（要ネットワーク）。
`examples/natsuneko/archon.config.ts` で一時ディレクトリに SDK を生成し、HTTP 200 と `data` が `undefined` でないことを確認して、1 件でも失敗すれば非ゼロで終了します。

```sh
node --experimental-strip-types scripts/live-smoke.ts
```

spec 上 `security: []` の GET で必須パラメータが無いものは現状 2 件（`/catalyst/v1/announcements`、`/feature-flags/v1/me`）しか無いため、3 件目には任意認証（`{}` を含む）の `/catalyst/v1.1/timeline/newcomers` を使います。なお `GET /feature-flags/v1/me` は spec が認証不要としているにもかかわらず実 API が 401 を返すため、このスモークは失敗します（spec と実 API の不一致を検出している状態です）。

Archon のソースは `.js` 付きの相対 import を使っており Node の型除去だけでは読み込めないため、スクリプトは jiti 経由でソースと生成 SDK を読み込みます（事前の `pnpm build` は不要）。

## ライセンス

未定。
