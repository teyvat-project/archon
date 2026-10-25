# Archon M1（コア + TypeScript）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenAPI 3.0 / 3.1 を IR に正規化して言語プラグインに渡すコア一式と、TypeScript プラグイン + vendored ランタイムを実装する。edge-cases spec に対する E2E が通ることを完了条件とする。

**Architecture:** `packages/archon` が loader → patch → parser → passes → plugin host → writer のパイプラインを持つ。TypeScript プラグインは IR から `types.gen.ts` / `sdk.gen.ts` / `client.gen.ts` を出力し、`runtimes/typescript/src` の手書きランタイムを出力先 `core/` にコピーする。E2E は Node 製モックサーバに対し、生成 SDK を vitest から実行する。

**Tech Stack:** Node 24, TypeScript ^5.9, pnpm 10 workspace, vitest ^3.2, tsup ^8.5, jiti ^2, yaml ^2.8, @apidevtools/json-schema-ref-parser ^11, cac ^6.7

**Spec:** `docs/superpowers/specs/2026-10-25-archon-design.md`

## Global Constraints

- 生成 TS SDK の実行時依存はゼロ。使ってよいグローバルは `fetch` / `Request` / `Response` / `Headers` / `URL` / `FormData` / `Blob` / `AbortController` / `TextEncoder` / `TextDecoder` / `setTimeout` のみ（Node 固有 API・`AbortSignal.any`・`AbortSignal.timeout`・`btoa` は使わない）。
- 生成 TS は ESM のみ。対象: Browser / Node.js 18+ / Bun / Deno / React Native / Cloudflare Workers。
- 生成 TS の tsconfig 前提: `strict: true`, `target: ES2022`, `lib: ["ES2022", "DOM"]`, `module: "NodeNext"`。
- フックはすべて `undefined` を返すと既定動作にフォールバックする。
- フィルタ構文: `"METHOD /path"` 完全一致、または `/regex/` 文字列。include と exclude が両方一致した場合は exclude が優先。
- requestBody の media type 優先順: json > multipart > form > text > binary。
- media type 分類: `application/json` と `+json` → json、`application/x-www-form-urlencoded` → form、`multipart/*` → multipart、`text/*` → text、それ以外 → binary。
- 操作名の導出: `method` + パスセグメントの camelCase。`{x}` は `By` + `X`（例: `GET /catalyst/v1/album/by/id/{id}` → `getCatalystV1AlbumByIdById`）。
- 認証適用は middleware チェーンの最内側（transport 直前）。
- OAuth2 トークンは期限 30 秒前に先回り更新し、更新は single-flight。401 時は 1 回だけ強制更新して再送する。
- Logging は `Authorization` / `Cookie` / `Proxy-Authorization` / apiKey スキームのヘッダ・クエリをマスクする。
- 生成物の各ファイル先頭には生成ヘッダを付与する（`output.header` で上書き可）。

## Spec からの M1 における意図的な差分

- TS プラグインの `bigint`（int64）オプションは M1 では実装しない。`JSON.parse` は精度を落とすため、独自 JSON パーサが必要になる。M1 完了後に別途扱う。
- TS プラグインでは `naming.property` / `hooks.propertyName` / `naming.file` / `hooks.fileName` を提供しない。TS のプロパティ名はワイヤ形式と一致させる必要があり、生成ファイル名は固定（`types.gen.ts` 等）のため。他言語プラグインでは提供する。
- パッケージマネージャは spec どおり pnpm workspace（vite-plus の shim 経由）。

## Review Focus

- **baseUrl にパスや末尾スラッシュがある**（`https://x.test/api/` + `/foo`）→ `https://x.test/api/foo` になること。二重スラッシュやパスの欠落を起こさない。→ Task 14 にテストを追加。
- **自己参照 / 相互参照する schema**（`Comment.replies: Comment[]`、A→B→A）→ parser / hoist / readWrite / 型出力が無限ループせず、名前参照で出力されること。→ Task 4、Task 9、Task 17 にテストを追加。
- **TS 識別子として不正な名前**（プロパティ `x-foo` / `2fa` / `with space`、schema 名 `Foo.Bar` / `foo-bar` / `1Thing`）→ プロパティは引用符付きキー、型名は正規化された PascalCase（先頭が数字なら `_` を前置）。→ Task 17 にテストを追加。
- **path パラメータ値に予約文字**（`a/b?c#d e`、`日本`）→ percent-encode されて 1 セグメントに収まること。→ Task 13 にテストを追加。
- **導出した操作名の衝突**（`GET /foo/{id}` と `GET /foo/by/id` はどちらも `getFooById`）→ 2 つ目以降に数値接尾辞（`getFooById2`）を付け、`--verbose` でログに出す。→ Task 5 にテストを追加。

---

## File Structure

```
package.json                     # workspace root（packageManager: pnpm@10.12.1）
pnpm-workspace.yaml              # packages/*, runtimes/typescript, e2e/*
tsconfig.base.json
vitest.workspace.ts
.gitignore
fixtures/specs/natsuneko.json    # api.natsuneko.com のスナップショット
fixtures/specs/petstore.yaml     # OpenAPI 3.0.3 の最小 petstore
fixtures/specs/edge-cases.yaml   # 全機能網羅（OpenAPI 3.1.0）

packages/archon/
  package.json  tsconfig.json  tsup.config.ts
  scripts/copy-runtimes.mjs      # build 時に ../../runtimes/* を ./runtimes/* にコピー
  src/index.ts                   # 公開 API: defineConfig, definePlugin, generate, IR 型
  src/plugins.ts                 # 'archon/plugins' エントリ: typescript
  src/diagnostics.ts
  src/ir/types.ts
  src/ir/walk.ts                 # schema の走査・置換ユーティリティ
  src/loader/load.ts
  src/loader/patch.ts
  src/parser/index.ts            # parseDocument
  src/parser/schema.ts           # parseSchema
  src/parser/operation.ts        # 操作・パラメータ・body・responses・security
  src/parser/naming.ts           # deriveOperationName
  src/passes/index.ts            # runCommonPasses / runPluginPasses
  src/passes/filters.ts          # applyFilters, removeOrphans, renameSchemas
  src/passes/all-of.ts
  src/passes/discriminator.ts
  src/passes/hoist.ts
  src/passes/read-write.ts
  src/config/types.ts
  src/config/load.ts
  src/config/resolve.ts
  src/plugin/types.ts
  src/plugin/define.ts
  src/plugin/host.ts
  src/writer/code-writer.ts
  src/writer/naming.ts
  src/writer/output.ts
  src/generate.ts
  src/cli.ts
  src/plugins/typescript/index.ts      # definePlugin 本体・オプション
  src/plugins/typescript/types.ts      # schema → TS 型出力
  src/plugins/typescript/sdk.ts        # sdk.gen.ts
  src/plugins/typescript/client.ts     # client.gen.ts, index.ts
  src/plugins/typescript/transformers.ts  # dates: 'Date' 用
  src/plugins/typescript/package.ts    # package.json, tsconfig.json
  src/plugins/typescript/runtime.ts    # ランタイムのコピー
  src/plugins/typescript/reserved.ts
  test/**                              # vitest（src と同じ構造）

runtimes/typescript/
  package.json  tsconfig.json
  src/index.ts  src/types.ts  src/errors.ts  src/serialize.ts  src/body.ts
  src/client.ts  src/transport.ts  src/auth.ts  src/oauth2.ts  src/middleware.ts  src/base64.ts
  test/*.test.ts

e2e/mock-server/src/{server.ts, routes/*.ts}   # edge-cases.yaml を実装（依存なし node:http）
e2e/typescript/{vitest.config.ts, global-setup.ts, test/*.test.ts}   # generated/ は gitignore
scripts/live-smoke.ts            # api.natsuneko.com への手動スモーク
```

### 依存してよいもの（Meta SDK 本体）

`packages/archon`: `yaml`, `@apidevtools/json-schema-ref-parser`, `jiti`, `cac`。dev: `typescript`, `vitest`, `tsup`, `@types/node`。

---

## Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `packages/archon/{package.json,tsconfig.json,tsup.config.ts,src/index.ts}`, `runtimes/typescript/{package.json,tsconfig.json,src/index.ts}`, `fixtures/specs/natsuneko.json`
- Test: `packages/archon/test/smoke.test.ts`

**Interfaces:**
- Produces: `pnpm test`（全 workspace の vitest）、`pnpm -F archon build`、`pnpm typecheck`（`tsc -b` 相当）。パッケージ名 `archon`（packages/archon）、`@archon/runtime-typescript`（private）、`@archon/e2e-mock-server`（private）、`@archon/e2e-typescript`（private）。

- [ ] **Step 1:** root `package.json` に `"packageManager": "pnpm@10.12.1"`、`"type": "module"`、scripts `test: vitest run`、`typecheck: pnpm -r typecheck`、`build: pnpm -r build` を書く。`pnpm --version` が `10.12.1` を返すことを確認する（vite-plus の shim 経由。失敗したら `corepack enable pnpm` を実行）。
- [ ] **Step 2:** `.gitignore` に `node_modules/`, `dist/`, `e2e/typescript/generated/`, `packages/archon/runtimes/`, `*.tsbuildinfo`, `.tmp/` を書く。`tsconfig.base.json` は `strict`, `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `lib ["ES2022","DOM"]`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` とする。
- [ ] **Step 3:** `fixtures/specs/natsuneko.json` を `curl -sS https://api.natsuneko.com/openapi.json -o fixtures/specs/natsuneko.json` で取得する。
- [ ] **Step 4:** 失敗するテストを書く: `smoke.test.ts` で `import { version } from '../src/index.js'` し、`expect(version).toMatch(/^\d+\.\d+\.\d+/)`。
- [ ] **Step 5:** `pnpm install && pnpm test` → FAIL（`version` 未定義）。
- [ ] **Step 6:** `packages/archon/src/index.ts` に `export const version = '0.1.0'` を追加する。
- [ ] **Step 7:** `pnpm test` → PASS。
- [ ] **Step 8:** Commit `chore: scaffold pnpm workspace`。

## Task 2: IR 型と Diagnostics

**Files:**
- Create: `packages/archon/src/ir/types.ts`, `packages/archon/src/ir/walk.ts`, `packages/archon/src/diagnostics.ts`
- Test: `packages/archon/test/ir/walk.test.ts`, `packages/archon/test/diagnostics.test.ts`

**Interfaces:**
- Produces（以降の全タスクが使う）:
  - spec §4 の型をそのまま `ir/types.ts` に定義する: `IRDocument`, `IRServer`, `IRSecurityScheme`, `IRSchema`, `IRSchemaBase`, `IRProperty`, `IROperation`, `IRParameter`, `IRMediaType`, `IRResponse`。spec に無い補助型は次のとおり:
    ```ts
    type IRSecurityRequirement = { schemes: { name: string; scopes: string[] }[] }; // schemes: [] は {}（任意認証）
    type IROAuthFlow = { authorizationUrl?: string; tokenUrl?: string; refreshUrl?: string; scopes: Record<string, string> };
    type IROAuthFlows = { clientCredentials?: IROAuthFlow; authorizationCode?: IROAuthFlow; implicit?: IROAuthFlow; password?: IROAuthFlow };
    type IRServer = { url: string; description?: string; variables: Record<string, { default: string; enum?: string[] }> };
    ```
    `IRSchemaBase` には spec の項目に加えて `origin?: string`（元の JSON Pointer。ログと命名に使う）を持たせる。
  - `walk.ts`: `visitSchemas(ir: IRDocument, fn: (schema: IRSchema, path: SchemaPath) => void): void`（named schemas → operations の params / bodies / responses を深さ優先で走査。`ref` は辿らない）、`mapSchema(schema: IRSchema, fn: (s: IRSchema, path: SchemaPath) => IRSchema): IRSchema`（子 → 親の順に置換）、`collectRefs(schema: IRSchema): Set<string>`。`SchemaPath = string[]`（例: `['schemas','Status','properties','author']`）。
  - `diagnostics.ts`: `type Diagnostic = { level: 'info'|'warn'|'error'; code: string; message: string; pointer?: string }`、`class Diagnostics { constructor(opts?: { verbose?: boolean; sink?: (d: Diagnostic) => void }); info(code, message, pointer?): void; warn(code, message, pointer?): void; error(code, message, pointer?): never; readonly entries: Diagnostic[]; hasWarnings(): boolean }`、`class ArchonError extends Error { code: string; pointer?: string }`。`error()` は `ArchonError` を throw する。`info` は verbose のときだけ sink に流す（entries には常に記録する）。

- [ ] **Step 1:** 失敗するテストを書く。
  - `visitSchemas visits nested object/array/union children with paths`: object（プロパティ `a: array<string>`）を持つ IR に対し、訪問パスに `['schemas','X']`, `['schemas','X','properties','a']`, `['schemas','X','properties','a','items']` が含まれること。
  - `visitSchemas does not follow refs`: `ref` の先を訪問しないこと（訪問回数 = 実ノード数）。
  - `collectRefs finds refs inside union and additionalProperties`: `Set{'A','B'}` が返ること。
  - `Diagnostics.error throws ArchonError with code and pointer`。
  - `Diagnostics.info is recorded but not sunk unless verbose`。
- [ ] **Step 2:** `pnpm test packages/archon/test/ir packages/archon/test/diagnostics.test.ts` → FAIL。
- [ ] **Step 3:** 型・`walk.ts`・`diagnostics.ts` を実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(core): add IR types, schema walker and diagnostics`。

## Task 3: Loader と Patch

**Files:**
- Create: `packages/archon/src/loader/load.ts`, `packages/archon/src/loader/patch.ts`
- Test: `packages/archon/test/loader/load.test.ts`, `packages/archon/test/loader/patch.test.ts`, fixtures `packages/archon/test/fixtures/loader/{root.yaml,external.yaml}`

**Interfaces:**
- Produces:
  - `type OpenAPIDocument = Record<string, any> & { openapi: string }`
  - `type InputConfig = string | { path: string; headers?: Record<string, string> } | OpenAPIDocument`
  - `loadInput(input: InputConfig, opts: { cwd: string; diagnostics: Diagnostics }): Promise<OpenAPIDocument>` — 文字列が `http(s)://` なら fetch（headers 付き）、それ以外はファイルパス（cwd 相対）。拡張子 / 内容で JSON か YAML かを判定する。外部ファイルの `$ref` は `$RefParser.bundle` で内部化する（内部 `$ref` は保持）。`openapi` が `3.0.x` / `3.1.x` 以外（`swagger: "2.0"` を含む）なら `diagnostics.error('unsupported-version', ...)`。
  - `type PatchConfig = { document?: (doc: OpenAPIDocument) => void; schemas?: Record<string, (schema: any) => void>; operations?: Record<string, (operation: any) => void> }`
  - `applyPatch(doc: OpenAPIDocument, patch: PatchConfig | undefined, diagnostics: Diagnostics): void` — document → schemas → operations の順で適用する。operations のキーは `"METHOD /path"`（METHOD は大文字小文字を区別しない）。存在しないキーは warn `patch-target-missing`。

- [ ] **Step 1:** 失敗するテストを書く。
  - `loads YAML file and bundles external $ref`: `root.yaml` が `$ref: './external.yaml#/Pet'` を含み、結果に外部ファイルの内容が取り込まれ、`$ref` の値が `#/` で始まること。
  - `loads JSON object input as-is`（同一参照ではなく deep clone されていること: 元オブジェクトを書き換えても結果は変わらない）。
  - `fetches URL input with headers`: `node:http` で一時サーバを立て、`x-token` ヘッダを受け取ったら spec を返す。
  - `rejects swagger 2.0 with unsupported-version`。
  - `applyPatch applies schemas and operations patches` / `warns patch-target-missing for unknown operation`。
- [ ] **Step 2:** `pnpm test packages/archon/test/loader` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(core): add input loader and patch support`。

## Task 4: Parser — schemas

**Files:**
- Create: `packages/archon/src/parser/schema.ts`
- Test: `packages/archon/test/parser/schema.test.ts`

**Interfaces:**
- Consumes: IR 型, `Diagnostics`, `OpenAPIDocument`
- Produces:
  - `type SchemaContext = { doc: OpenAPIDocument; version: '3.0' | '3.1'; diagnostics: Diagnostics; pointer: string }`
  - `parseSchema(node: unknown, ctx: SchemaContext): IRSchema`
  - `parseComponentSchemas(doc, ctx): Map<string, IRSchema>`（`components.schemas` を宣言順で処理）

規則（spec §4.1 に加えて）:
- `$ref: '#/components/schemas/X'` → `{ kind: 'ref', name: 'X' }`（X が存在しなければ `diagnostics.error('broken-ref', …, pointer)`）。3.1 の兄弟 `description` / `deprecated` はメタに反映する。`#/components/schemas/` 以外を指す内部 ref は解決してインライン展開し、循環していれば `diagnostics.error('unsupported-ref')`。
- `type` 未指定: `properties` / `additionalProperties` があれば object、`items` があれば array、`enum` があれば値の型から推定、それ以外は `unknown`。
- `type: 'string'` + `format: 'binary'`（3.0）、または `contentMediaType` / `contentEncoding`（3.1）→ `binary`。
- `enum` の値に `null` を含む場合は除外し、`nullable: true` にする。単一値の `enum` は `enum` のまま（`const` にはしない。discriminator 推論で使う）。`const` は `const`。
- 3.0 の `exclusiveMinimum: true` 等の検証キーワードは IR に載せない（無視する。警告も出さない）。
- `not` / `if` / `then` / `else` / `patternProperties` → warn `unsupported-keyword`（pointer 付き）。`not` 単独なら `unknown`。
- `additionalProperties: true` または `{}` → `additionalProperties: { kind: 'unknown' }`。未指定 → `undefined`。`false` → `false`。
- `allOf` は `intersection`（平坦化は Task 7）。`oneOf` / `anyOf` は `union`。`discriminator` があれば mapping を `Map<value, schemaName>` にし、mapping が無いバリアントは ref 名をそのまま値にする。

- [ ] **Step 1:** 失敗するテストを書く（各ケースで `parseSchema` の戻り値を `toEqual` で比較する）。
  - `normalizes 3.1 type array with null to nullable`: `{type:['string','null']}` → `{kind:'string', nullable:true}`
  - `normalizes 3.0 nullable`: `{type:'integer', format:'int64', nullable:true}` → `{kind:'integer', format:'int64', nullable:true}`
  - `normalizes anyOf [X, null] to nullable X`: `{anyOf:[{$ref:'#/components/schemas/A'},{type:'null'}]}` → `{kind:'ref', name:'A', nullable:true}`
  - `converts multi-type array to union`: `{type:['string','number']}` → union（string, number）
  - `parses enum with null into nullable enum`: `{type:'string', enum:['a','b',null]}` → `{kind:'enum', base:'string', values:['a','b'], nullable:true}`
  - `parses object with required, additionalProperties true`
  - `parses binary from format and contentMediaType`
  - `parses oneOf with discriminator mapping`
  - `warns unsupported-keyword for not/if`
  - `errors broken-ref with JSON pointer for unresolvable $ref`: `{$ref:'#/components/schemas/Missing'}` → `ArchonError` code `broken-ref`、`pointer` が参照元の位置
  - `handles self-referencing schema without recursion`: `components.schemas.Comment = {type:'object', properties:{replies:{type:'array', items:{$ref:'#/components/schemas/Comment'}}}}` → `parseComponentSchemas` が返り、`replies.items` が `{kind:'ref', name:'Comment'}` であること（Review Focus）。
  - `parses natsuneko fixture schemas without errors`: `fixtures/specs/natsuneko.json` で `parseComponentSchemas(...).size === 97`、`diagnostics` に error が無いこと。
- [ ] **Step 2:** `pnpm test packages/archon/test/parser/schema.test.ts` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(core): parse OpenAPI schemas into IR`。

## Task 5: Parser — operations / security / servers

**Files:**
- Create: `packages/archon/src/parser/operation.ts`, `packages/archon/src/parser/naming.ts`, `packages/archon/src/parser/index.ts`
- Test: `packages/archon/test/parser/operation.test.ts`, `packages/archon/test/parser/naming.test.ts`

**Interfaces:**
- Consumes: `parseSchema`, `parseComponentSchemas`
- Produces:
  - `deriveOperationName(method: string, path: string): string`
  - `type ParserHooks = { operationName?: (op: IROperation, ctx: { derived: string }) => string | undefined; operationGroup?: (op: IROperation) => string | undefined }`
  - `parseDocument(doc: OpenAPIDocument, opts: { diagnostics: Diagnostics; hooks?: ParserHooks }): IRDocument`

規則:
- パラメータ: path-level と operation-level を `name + in` でマージし、operation 側を優先する。`components.parameters` の `$ref` は展開する。style の既定値は path / header → `simple`、query / cookie → `form`。explode は style が `form` のとき既定 `true`、それ以外は `false`。path パラメータは常に `required: true`。`content` 形式のパラメータは schema を `content` の唯一のエントリから取り、style は既定値にする。
- requestBody: `components.requestBodies` の ref を展開する。全 content を `IRMediaType` にし、優先順（Global Constraints）で並べ替える。採用しなかったものは `info('request-body-alternative-ignored')`。
- responses: `components.responses` の ref を展開する。status キーは数値文字列なら number、`2XX` 等はそのまま大文字、`default` はそのまま。204 / content 無しは `contents: []`。
- security: operation の `security` があればそれ、無ければ root の `security`、どちらも無ければ `[]`。各要素 `{}` は `{ schemes: [] }`。
- securitySchemes: `http` + `bearer`（大文字小文字無視）→ `http-bearer`、`basic` → `http-basic`、その他 → `http-other` + warn `unsupported-auth`。`mutualTLS` → warn `unsupported-auth`。
- servers: root の servers。無ければ `[{ url: '/', variables: {} }]`。operation / path-level の servers は `IROperation.servers`。
- name: `operationId` があればそれを camelCase 化、無ければ `deriveOperationName`。`hooks.operationName` が文字列を返せばそれを使う。重複したら 2 つ目以降に `2`, `3`… を付け、`info('operation-renamed')`。
- group: `hooks.operationGroup` → 先頭 tag → `undefined`。
- `id`: `"GET /path"`（METHOD は大文字）。

- [ ] **Step 1:** 失敗するテストを書く。
  - naming: `getCatalystV1AlbumByIdById` / `postCatalystV1Album` / `GET /catalyst/v1.1/on-this-day` → `getCatalystV11OnThisDay` / `DELETE /a/{b_c}` → `deleteAByBC` / `GET /` → `get`
  - `merges path-level and operation-level parameters with operation precedence`
  - `applies default style and explode per location`
  - `sorts request body contents by priority and logs ignored alternatives`
  - `inherits root security and maps {} to optional requirement`
  - `warns unsupported-auth for digest and mutualTLS`
  - `suffixes duplicate derived operation names`: `GET /foo/{id}` と `GET /foo/by/id` → `getFooById` と `getFooById2`（Review Focus）
  - `uses operationName hook result`
  - `parses natsuneko fixture`: operations 数が 199、全操作に `group` がある、security が `[]` の操作が 12 件、`GET /catalyst/v1/status/{id}` の security が `[{schemes:[{name:'bearerAuth', scopes:[]}]}]` と一致する。
  - `parses encoding of multipart request body into IRMediaType.encoding`
- [ ] **Step 2:** `pnpm test packages/archon/test/parser` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** 同コマンド → PASS。
- [ ] **Step 5:** Commit `feat(core): parse operations, security schemes and servers`。

## Task 6: Passes — filters / orphans / schemaName

**Files:**
- Create: `packages/archon/src/passes/filters.ts`
- Test: `packages/archon/test/passes/filters.test.ts`

**Interfaces:**
- Produces:
  - `type IncludeExclude = { include?: string[]; exclude?: string[] }`
  - `type FiltersConfig = { operations?: IncludeExclude; tags?: IncludeExclude; schemas?: IncludeExclude; deprecated?: boolean; orphans?: boolean; preserveOrder?: boolean }`
  - `matchesPattern(value: string, pattern: string): boolean`（`/…/flags` 形式なら RegExp、それ以外は完全一致）
  - `applyFilters(ir: IRDocument, filters: FiltersConfig | undefined): void` — operations（`op.id` に対して照合）→ tags（いずれかの tag が include に一致 / exclude に一致）→ schemas → deprecated（`false` なら deprecated の operation と schema を除去）の順で適用する。`preserveOrder: false`（既定）なら operations を `id` でソートし、schemas は名前でソートする。
  - `removeOrphans(ir: IRDocument): void` — 操作から到達可能な schema（ref を推移的に辿る）以外を削除する。
  - `renameSchemas(ir: IRDocument, schemaName: string | ((name: string) => string) | undefined, diagnostics: Diagnostics): void` — `{{name}}` テンプレート置換。既存名と衝突する改名はスキップして warn `schema-rename-conflict`。全 `ref` を書き換える。

- [ ] **Step 1:** 失敗するテストを書く: `include regex and exclude exact (exclude wins)`、`tag filter`、`deprecated false removes deprecated operations and schemas`、`orphans removes unreachable schemas but keeps transitive refs`、`renameSchemas applies template and rewrites refs`、`renameSchemas skips conflicting rename with warning`、`sorts by id unless preserveOrder`。
- [ ] **Step 2:** `pnpm test packages/archon/test/passes/filters.test.ts` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): add filter, orphan and rename passes`。

## Task 7: Passes — allOf 平坦化 / discriminator 推論

**Files:**
- Create: `packages/archon/src/passes/all-of.ts`, `packages/archon/src/passes/discriminator.ts`
- Test: `packages/archon/test/passes/all-of.test.ts`, `packages/archon/test/passes/discriminator.test.ts`

**Interfaces:**
- Produces:
  - `flattenAllOf(ir: IRDocument, diagnostics: Diagnostics): void` — `intersection` の全メンバーが object（`ref` は named schema を解決して object なら可）なら、プロパティを合成した object に置き換える。同名プロパティは後勝ち、`required` は OR、`additionalProperties` は最後に指定されたもの。メンバーに object 以外が含まれる場合は `intersection` のまま残す。named schema の ref を解決する際の循環は検出して打ち切る。
  - `inferDiscriminators(ir: IRDocument): void` — `discriminator` を持たない `union` について、全バリアントが object（ref 解決後）で、全バリアントに `required` かつ `const` または単一値 `enum`（string）のプロパティが共通に存在し、その値が全バリアントで互いに異なる場合に `discriminator: { property, mapping: Map<value, refName> }` を設定する。バリアントが inline object の場合は mapping の値を `''` にする（hoist 後に名前を埋める。Task 8）。候補が複数あれば最初に宣言されたプロパティを採る。

- [ ] **Step 1:** 失敗するテストを書く: `merges object members and required`、`keeps intersection when a member is a primitive`、`resolves ref members`、`terminates on cyclic allOf`、`infers discriminator from single-value enum property`（natsuneko の `type: {enum:['standard']}` / `{enum:['custom']}` パターンを再現）、`does not infer when values collide or property is optional`。
- [ ] **Step 2:** 該当テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): flatten allOf and infer discriminators`。

## Task 8: Passes — inline 巻き上げ / enum 巻き上げ

**Files:**
- Create: `packages/archon/src/passes/hoist.ts`
- Test: `packages/archon/test/passes/hoist.test.ts`

**Interfaces:**
- Produces:
  - `type HoistOptions = { objects: boolean; enums: boolean; nameHook?: (path: SchemaPath, ctx: { suggested: string }) => string | undefined }`
  - `hoistInlineSchemas(ir: IRDocument, opts: HoistOptions): void` — inline の object（プロパティを 1 つ以上持つもの）/ enum / 判別あり union のバリアント object を named schema に移し、`ref` に置き換える。`nullable` 等のメタは ref 側に残す。
  - 命名規則（`suggested`）: 
    - schema のプロパティ → `{Parent}{Prop}`（PascalCase）
    - 配列要素 → 親の名前（`{Parent}{Prop}Item`）
    - union バリアント → `{Parent}{DiscriminatorValue}`、判別なしなら `{Parent}Variant{N}`（1 始まり）
    - operation の body → `{OperationName}Body`、response → `{OperationName}Response{Status}`、パラメータ → `{OperationName}{ParamName}`
  - 衝突は `2`, `3`… を接尾辞にして解決する。inferDiscriminators が残した mapping の `''` を巻き上げ後の名前で埋める。

- [ ] **Step 1:** 失敗するテストを書く: `hoists nested inline objects with Parent+Prop names`、`hoists inline enums only when enums=true`、`names union variants by discriminator value`、`suffixes conflicting names`、`fills discriminator mapping for hoisted variants`、`uses nameHook result when provided`、`does not hoist empty objects (additionalProperties-only maps)`。
- [ ] **Step 2:** `pnpm test packages/archon/test/passes/hoist.test.ts` → FAIL。
- [ ] **Step 3:** 実装する（子 → 親ではなく親 → 子の順で処理し、親の確定名を子の命名に使う）。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): hoist inline schemas and enums`。

## Task 9: Passes — readWrite 分割 / パス実行器

**Files:**
- Create: `packages/archon/src/passes/read-write.ts`, `packages/archon/src/passes/index.ts`
- Test: `packages/archon/test/passes/read-write.test.ts`, `packages/archon/test/passes/index.test.ts`

**Interfaces:**
- Produces:
  - `type ReadWriteOptions = false | { requests?: string; responses?: string }`（既定テンプレート: requests `'{{name}}Writable'`、responses `'{{name}}'`）
  - `splitReadWrite(ir: IRDocument, opts: ReadWriteOptions): void` — `readOnly` / `writeOnly` プロパティを（推移的に）含む named schema について、request 用（readOnly を除いたもの）と response 用（writeOnly を除いたもの）の 2 つを作る。request body から到達する ref を request 用の名前に、response から到達する ref を response 用の名前に書き換える。どちらにも該当しない schema は 1 つのままにする。
  - `type TransformsConfig = { enums?: 'root' | 'inline'; inferDiscriminator?: boolean; readWrite?: ReadWriteOptions; schemaName?: string | ((name: string) => string) }`
  - `runCommonPasses(ir: IRDocument, opts: { filters?: FiltersConfig; transforms?: TransformsConfig; inlineSchemaName?: HoistOptions['nameHook'] }, diagnostics: Diagnostics): void` — 順序: applyFilters → flattenAllOf → inferDiscriminators（既定 true）→ enums==='root' なら hoist(enums only) → splitReadWrite（既定 false）→ renameSchemas → removeOrphans（`filters.orphans === false` のとき）。
  - `runPluginPasses(ir: IRDocument, req: { hoistInlineObjects?: boolean; hoistInlineEnums?: boolean }, nameHook?: HoistOptions['nameHook']): IRDocument` — `structuredClone(ir)` に対して hoist を適用して返す（元の IR は変更しない）。

- [ ] **Step 1:** 失敗するテストを書く: `splits schema with readOnly id into Writable variant used by request body`、`leaves schemas without readOnly/writeOnly untouched`、`propagates split to schemas referencing split schema`、`terminates on cyclic schemas with readOnly`（Review Focus）、`runCommonPasses executes in documented order`（spy で順序を確認）、`runPluginPasses does not mutate original IR`。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): add readWrite split and pass runner`。

## Task 10: Config

**Files:**
- Create: `packages/archon/src/config/types.ts`, `packages/archon/src/config/load.ts`, `packages/archon/src/config/resolve.ts`
- Modify: `packages/archon/src/index.ts`（`defineConfig` と型を export）
- Test: `packages/archon/test/config/*.test.ts`, fixtures `packages/archon/test/fixtures/config/{archon.config.ts,archon.config.json,multi.config.mjs}`

**Interfaces:**
- Consumes: `InputConfig`, `PatchConfig`, `FiltersConfig`, `TransformsConfig`, `ParserHooks`, `HoistOptions['nameHook']`
- このタスクで `packages/archon/src/plugin/types.ts` を作成し、Task 11 の Interfaces にある型宣言（`EmittedFile`, `IRRequirements`, `PluginContext`, `PluginDefinition`, `ArchonPlugin`）を型だけ先に置く（config と plugin の型は相互参照する）。挙動は Task 11 で実装する。
- Produces:
  ```ts
  type HeaderContext = { defaultValue: string[]; language: string };
  type PostProcessCommand = { command: string; args: string[] };
  type OutputConfig = { path: string; clean?: boolean; header?: (ctx: HeaderContext) => string[]; postProcess?: PostProcessCommand[] };
  type UserConfig = {
    input: InputConfig;
    output: string | OutputConfig;
    parser?: { filters?: FiltersConfig; patch?: PatchConfig; transforms?: TransformsConfig;
               hooks?: ParserHooks & { inlineSchemaName?: HoistOptions['nameHook'] } };
    plugins?: ArchonPlugin<any, any>[];
  };
  type ResolvedConfig = Required<Pick<UserConfig, 'input' | 'plugins'>> & { output: Required<OutputConfig>; parser: NonNullable<UserConfig['parser']>; root: string };
  defineConfig(config: UserConfig | UserConfig[]): UserConfig | UserConfig[];
  loadConfigFile(opts: { cwd: string; file?: string }): Promise<UserConfig[]>;   // 探索順: archon.config.{ts,mts,mjs,js,json}
  resolveConfig(config: UserConfig, opts: { cwd: string }): ResolvedConfig;
  ```
  既定値: `output.clean = true`、`header` = 恒等、`postProcess = []`、`plugins = []`（空なら warn `no-plugins`）。`root` は設定ファイルのディレクトリ（ファイルが無い場合は cwd）で、`input` / `output.path` の相対パスの基準になる。

- [ ] **Step 1:** 失敗するテストを書く: `loads ts config via jiti`、`loads json config`、`returns array for multi-job config`、`errors when no config file found`（`ArchonError` code `config-not-found`）、`resolves output string shorthand and defaults`、`resolves relative paths against config dir`。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): add config definition and loader`。

## Task 11: Plugin API / host / CodeWriter / output writer

**Files:**
- Create: `packages/archon/src/plugin/{types.ts,define.ts,host.ts}`, `packages/archon/src/writer/{code-writer.ts,naming.ts,output.ts}`
- Modify: `packages/archon/src/index.ts`（`definePlugin`, `CodeWriter`, naming ユーティリティを export）
- Test: `packages/archon/test/plugin/host.test.ts`, `packages/archon/test/writer/{code-writer,naming,output}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // plugin/types.ts
  type EmittedFile = { path: string; content: string | Uint8Array };      // path は output.path 相対
  type IRRequirements = { hoistInlineObjects?: boolean; hoistInlineEnums?: boolean };
  interface PluginContext<O> {
    ir: IRDocument;                    // このプラグイン用（runPluginPasses 済み）
    options: O;
    config: ResolvedConfig;
    outputDir: string;                 // output.path 相対のサブディレクトリ
    diagnostics: Diagnostics;
    emit(relativePath: string, content: string | Uint8Array): void;  // outputDir 相対
    headerLines(language: string): string[];   // output.header 適用済みの生成ヘッダ行（コメント記号なし）
    writer(opts?: { indent?: string }): CodeWriter;
    plugin<API = unknown>(name: string): API;  // 依存プラグインの generate 戻り値。未実行なら ArchonError
  }
  interface PluginDefinition<O, API> {
    name: string;
    defaults: O;
    dependencies?: string[];
    irRequirements?: (options: O) => IRRequirements;
    transformIR?: (ir: IRDocument, ctx: { options: O; diagnostics: Diagnostics }) => void;
    generate: (ctx: PluginContext<O>) => API | void | Promise<API | void>;
    factories?: Record<string, (options?: any) => ArchonPlugin<any, any>>;  // 依存の自動追加用（name → factory）
  }
  interface ArchonPlugin<O, API> { name: string; options: O; definition: PluginDefinition<O, API> }
  // plugin/define.ts
  definePlugin<O, API = void>(def: PluginDefinition<O, API>): (options?: DeepPartial<O>) => ArchonPlugin<O, API>; // options は defaults に deep merge（配列は置換）
  // plugin/host.ts
  runPlugins(ir: IRDocument, config: ResolvedConfig, diagnostics: Diagnostics, opts?: { only?: string[] }): Promise<EmittedFile[]>;
  ```
  host の動作: dependencies に挙がった未登録プラグインは `definition.factories?.[name]` があれば既定オプションで自動追加し、無ければ `ArchonError('plugin-missing-dependency')`。トポロジカルソートし、循環は `ArchonError('plugin-cycle')`。全プラグインの `transformIR` を共通 IR に順に適用した後、各プラグインについて `runPluginPasses` → `generate` を実行する。`outputDir` の既定はプラグインの `options.output ?? name`。同一パスへの二重 emit は `ArchonError('duplicate-output')`。
  ```ts
  // writer/code-writer.ts
  class CodeWriter {
    constructor(opts?: { indent?: string });             // 既定 2 スペース
    line(text?: string): this;
    lines(texts: string[]): this;
    blank(): this;                                        // 連続する空行は 1 行にまとめる
    indent(fn: () => void): this;
    block(open: string, fn: () => void, close?: string): this;   // close 既定 '}'
    comment(lines: string[], style: 'jsdoc' | 'line'): this;     // 空配列なら何も出さない。'*/' はエスケープ
    toString(): string;                                   // 末尾改行 1 つ
  }
  // writer/naming.ts
  type NameCase = 'camelCase' | 'PascalCase' | 'snake_case' | 'SCREAMING_SNAKE_CASE' | 'kebab-case' | 'preserve';
  splitWords(input: string): string[];                    // 区切り記号・camel 境界・数字境界で分割
  toCase(input: string, c: NameCase): string;
  applyTemplate(template: string | ((name: string) => string) | undefined, name: string): string;
  class UniqueNamer { constructor(reserved?: Iterable<string>, opts?: { caseInsensitive?: boolean }); claim(base: string): string }  // 衝突時 base2, base3…
  // writer/output.ts
  writeOutput(files: EmittedFile[], output: Required<OutputConfig>, opts: { root: string; diagnostics: Diagnostics }): Promise<void>;
  ```
  `writeOutput`: `clean` なら、今回 emit したプラグインの outputDir だけを削除してから書く（output.path 全体は消さない）。その後 `postProcess` を順に `spawn`（`{{path}}` を output.path の絶対パスに置換）し、非 0 終了は warn `post-process-failed`。

- [ ] **Step 1:** 失敗するテストを書く。
  - naming: `toCase('getCatalystV1AlbumByIdById','snake_case') === 'get_catalyst_v1_album_by_id_by_id'`、`toCase('x-foo bar','PascalCase') === 'XFooBar'`、`toCase('HTTPServer','camelCase') === 'httpServer'`、`applyTemplate('Api{{name}}','Foo') === 'ApiFoo'`、`UniqueNamer` の case-insensitive 衝突。
  - code-writer: ネストしたブロックのインデント、`blank` の連続抑止、`comment(['a */ b'],'jsdoc')` が `*\/` をエスケープすること。
  - host: `runs plugins in dependency order`、`auto-adds missing dependency via factories`、`fails on dependency cycle`、`plugin() returns dependency API`、`plugin receives hoisted IR only when it requested`、`transformIR mutations are visible to all plugins`、`duplicate emit path fails`。
  - output: `clean removes only emitted plugin dirs`、`writes files with nested dirs`、`runs postProcess with {{path}}`（`node -e` で marker ファイルを作るコマンド）。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(core): add plugin host, code writer and output writer`。

## Task 12: generate() と CLI

**Files:**
- Create: `packages/archon/src/generate.ts`, `packages/archon/src/cli.ts`
- Modify: `packages/archon/package.json`（`bin: { archon: './dist/cli.js' }`、`exports` に `.` と `./plugins`）、`packages/archon/src/index.ts`
- Test: `packages/archon/test/generate.test.ts`, `packages/archon/test/cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type GenerateOptions = { cwd?: string; strict?: boolean; verbose?: boolean; plugins?: string[]; logger?: (d: Diagnostic) => void };
  type GenerateResult = { jobs: { files: string[]; diagnostics: Diagnostic[] }[] };
  generate(config: UserConfig | UserConfig[], opts?: GenerateOptions): Promise<GenerateResult>;
  ```
  ジョブごとに loadInput → applyPatch → parseDocument → runCommonPasses → runPlugins → writeOutput を実行する。`strict` で warn が 1 件でもあれば writeOutput の前に `ArchonError('strict-warnings')`。
  CLI（cac）: `archon generate [-c, --config <file>] [--plugin <name>...] [--strict] [--verbose]`。終了コードは成功 0、ArchonError 1。診断は `level code: message (pointer)` 形式で stderr に出す。`archon init` は cwd に `archon.config.ts` のひな形を書く（既存なら上書きせず終了コード 1）。ひな形の内容は spec §5.1 の例から `input` と `typescript()` だけを残したもの。

- [ ] **Step 1:** 失敗するテストを書く: `generate runs full pipeline with a fake plugin and writes files`、`strict fails on warnings`、`plugins option limits executed plugins`、`cli generate exits 1 and prints code on ArchonError`（`node dist/cli.js` ではなく `runCli(argv)` を export してテストする）、`cli init writes template and refuses overwrite`。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。`cli.ts` は `export async function runCli(argv: string[]): Promise<number>` と、`import.meta.url` がエントリのとき `process.exit(await runCli(process.argv))` を実行する部分からなる。
- [ ] **Step 4:** PASS を確認する。`pnpm -F archon build` が成功し、`node packages/archon/dist/cli.js --help` で usage が出ることも確認する。
- [ ] **Step 5:** Commit `feat(core): add generate pipeline and CLI`。

## Task 13: TS runtime — types / errors / パラメータ直列化

**Files:**
- Create: `runtimes/typescript/src/{types.ts,errors.ts,serialize.ts}`
- Test: `runtimes/typescript/test/serialize.test.ts`, `runtimes/typescript/test/errors.test.ts`

**Interfaces:**
- Produces（ランタイム公開型。以降の runtime タスクと TS プラグインが使う）:
  ```ts
  type HttpMethod = 'GET'|'PUT'|'POST'|'DELETE'|'OPTIONS'|'HEAD'|'PATCH'|'TRACE';
  type ParamStyle = 'simple'|'label'|'matrix'|'form'|'spaceDelimited'|'pipeDelimited'|'deepObject';
  interface ParamSpec { name: string; in: 'path'|'query'|'header'|'cookie'; style: ParamStyle; explode: boolean; allowReserved?: boolean }
  type BodyKind = 'json'|'form'|'multipart'|'text'|'binary';
  type ResponseKind = 'json'|'text'|'binary'|'empty';
  type SecuritySchemeSpec =
    | { type: 'http'; scheme: 'bearer' | 'basic' }
    | { type: 'apiKey'; in: 'header'|'query'|'cookie'; name: string }
    | { type: 'oauth2'; tokenUrl?: string; refreshUrl?: string }
    | { type: 'openIdConnect' };
  type SecurityRequirement = { scheme: string; scopes: string[] }[];    // AND。[] は任意認証
  interface OperationSpec {
    operationName: string; method: HttpMethod; path: string; tags: string[];
    security: SecurityRequirement[]; params: ParamSpec[];
    body?: { kind: BodyKind; mediaType: string };
    responses: Record<string, ResponseKind>;      // キー: '200' | '2XX' | 'default'
    transform?: (data: unknown) => unknown;       // dates: 'Date' 用
  }
  type RequestBody = string | Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | ReadableStream<Uint8Array>;
  interface ApiRequest { method: HttpMethod; url: URL; headers: Headers; body: RequestBody | null; replayable: boolean; signal?: AbortSignal }
  type ApiResponse = Response;
  interface CallContext {
    operationName: string; method: HttpMethod; pathTemplate: string; tags: string[];
    security: SecurityRequirement[]; attempt: number; signal?: AbortSignal;
    redact: { headers: string[]; query: string[] };     // logging 用（小文字）
    extensions: Record<string, unknown>;
  }
  type Next = (req: ApiRequest) => Promise<ApiResponse>;
  type Middleware = (req: ApiRequest, next: Next, ctx: CallContext) => Promise<ApiResponse>;
  ```
  errors: `class ApiError<E = unknown> extends Error { readonly status: number; readonly body: E; readonly response: Response }`、`class TransportError extends Error { readonly timedOut: boolean; readonly cause: unknown }`、`class DecodeError extends Error { readonly raw: string; readonly response: Response }`、`class AuthError extends Error { readonly schemes: string[] }`。各クラスの `name` はクラス名と一致させる。
  serialize:
  ```ts
  serializePath(template: string, specs: ParamSpec[], values: Record<string, unknown> | undefined): string;
  serializeQuery(specs: ParamSpec[], values: Record<string, unknown> | undefined): string;   // '?' なし。空なら ''
  serializeHeader(spec: ParamSpec, value: unknown): string | undefined;
  serializeCookie(specs: ParamSpec[], values: Record<string, unknown> | undefined): string | undefined;   // 'a=1; b=2'
  ```
  エンコード: 値は `encodeURIComponent`。`allowReserved` のときは RFC 3986 reserved 文字 `:/?#[]@!$&'()*+,;=` を元に戻す。区切り文字（`,` `.` `;` `=` `&` `|` `%20` `[` `]`）は下表のとおりリテラルで出力する。`undefined` / `null` の値は出力しない。`Date` は `toISOString()`、boolean / number は `String()`。

- [ ] **Step 1:** 失敗するテストを書く。`serialize.test.ts` は値 `string='blue'`、`array=['blue','black','brown']`、`object={R:100,G:200,B:150}`、名前 `color` で、次の期待値の表駆動テストにする（RFC 6570 準拠）。

  | style | explode | string | array | object |
  |---|---|---|---|---|
  | matrix | false | `;color=blue` | `;color=blue,black,brown` | `;color=R,100,G,200,B,150` |
  | matrix | true | `;color=blue` | `;color=blue;color=black;color=brown` | `;R=100;G=200;B=150` |
  | label | false | `.blue` | `.blue,black,brown` | `.R,100,G,200,B,150` |
  | label | true | `.blue` | `.blue.black.brown` | `.R=100.G=200.B=150` |
  | simple | false | `blue` | `blue,black,brown` | `R,100,G,200,B,150` |
  | simple | true | `blue` | `blue,black,brown` | `R=100,G=200,B=150` |
  | form | false | `color=blue` | `color=blue,black,brown` | `color=R,100,G,200,B,150` |
  | form | true | `color=blue` | `color=blue&color=black&color=brown` | `R=100&G=200&B=150` |
  | spaceDelimited | false | — | `color=blue%20black%20brown` | `color=R%20100%20G%20200%20B%20150` |
  | pipeDelimited | false | — | `color=blue\|black\|brown` | `color=R\|100\|G\|200\|B\|150` |
  | deepObject | true | — | — | `color[R]=100&color[G]=200&color[B]=150` |

  追加ケース:
  - `percent-encodes reserved chars in path values`: `serializePath('/files/{name}', [simple name], {name:'a/b?c#d e'})` → `/files/a%2Fb%3Fc%23d%20e`。`'日本'` → `%E6%97%A5%E6%9C%AC`（Review Focus）
  - `allowReserved keeps reserved chars in query`
  - `skips undefined and null`、`serializes Date as ISO string`、`serializeCookie joins with '; '`
  - errors: `ApiError exposes status/body and name`
- [ ] **Step 2:** `pnpm -F @archon/runtime-typescript test` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(runtime-ts): add runtime types, errors and parameter serialization`。

## Task 14: TS runtime — body / transport / client / middleware compose

**Files:**
- Create: `runtimes/typescript/src/{body.ts,transport.ts,client.ts,middleware.ts,index.ts}`
- Test: `runtimes/typescript/test/{body,client,transport}.test.ts`

**Interfaces:**
- Consumes: Task 13 の型と関数。auth は Task 15 の `createAuthMiddleware`（このタスクでは `client.ts` から import する前提で、Task 15 までは何もしないスタブを `auth.ts` に置く）。
- Produces:
  ```ts
  // body.ts
  encodeBody(kind: BodyKind, mediaType: string, value: unknown): { body: RequestBody; contentType?: string; replayable: boolean };
  decodeBody(kind: ResponseKind, response: Response): Promise<unknown>;
  // middleware.ts
  compose(middleware: Middleware[], terminal: Next, ctx: CallContext): Next;
  // transport.ts
  type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  send(req: ApiRequest, opts: { fetch: FetchLike; timeoutMs?: number; credentialHeaders: string[]; credentialQuery: string[] }): Promise<Response>;
  // client.ts
  type TokenValue = string | (() => string | Promise<string>);
  type BasicValue = { username: string; password: string } | (() => { username: string; password: string } | Promise<{ username: string; password: string }>);
  type OAuth2Value = { accessToken?: TokenValue; clientCredentials?: { clientId: string; clientSecret: string; scopes?: string[]; tokenUrl?: string; clientAuth?: 'basic' | 'post' };
                       refreshToken?: { refreshToken: string; clientId: string; clientSecret?: string; tokenUrl?: string; clientAuth?: 'basic' | 'post'; onRefreshed?: (tokens: TokenSet) => void | Promise<void> } };
  type AuthConfig = Record<string, TokenValue | BasicValue | OAuth2Value | undefined>;
  interface ClientConfig<TAuth extends AuthConfig = AuthConfig> {
    baseUrl: string; securitySchemes: Record<string, SecuritySchemeSpec>;
    auth?: TAuth; headers?: Record<string, string>; timeout?: number; middleware?: Middleware[];
    fetch?: FetchLike; throwOnError?: boolean;
    customAuth?: (req: ApiRequest, ctx: CallContext) => void | Promise<void>;
  }
  interface RequestOptions<ThrowOnError extends boolean = boolean> {
    path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, unknown>;
    cookies?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; throwOnError?: ThrowOnError;
    extensions?: Record<string, unknown>; baseUrl?: string;
  }
  type RequestResult<TData, TError, ThrowOnError extends boolean> = ThrowOnError extends true
    ? { data: TData; response: Response }
    : { data: TData; error: undefined; response: Response } | { data: undefined; error: ApiError<TError>; response: Response };
  interface Client<TAuth extends AuthConfig = AuthConfig> {
    getConfig(): ClientConfig<TAuth>;
    setConfig(config: Partial<ClientConfig<TAuth>>): void;
    use(...middleware: Middleware[]): void;
    request<TData, TError, ThrowOnError extends boolean = false>(op: OperationSpec, options?: RequestOptions<ThrowOnError>): Promise<RequestResult<TData, TError, ThrowOnError>>;
  }
  createClient<TAuth extends AuthConfig = AuthConfig>(config: ClientConfig<TAuth>): Client<TAuth>;
  ```
  `TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }` は `types.ts` に追加する。`index.ts` は上記すべてと Task 13 / 15 / 16 の公開物を re-export する。

挙動:
- URL: `joinUrl(baseUrl, path)` は baseUrl 末尾の `/` と path 先頭の `/` を 1 つにまとめる。baseUrl のパスは保持する（`new URL(path, base)` は使わない）。
- ヘッダ構築順: `config.headers` → header パラメータ（`serializeHeader`）→ `options.headers` のうちパラメータ定義に無いキー → cookie パラメータを `Cookie` に → body の `Content-Type`（multipart は設定しない）→ `Accept`（responses の kind に json があれば `application/json`、それ以外は `*/*`）。
- チェーン: `[...config.middleware, authMiddleware]` を compose し、terminal は `send`。`client.use` は config.middleware の末尾に追加する（auth より外側）。
- `ctx.attempt` は 1 から始まり、チェーン再入時の加算は middleware 側（Task 16）が行う。
- 結果: レスポンスの kind は `responses[status] ?? responses['NXX'] ?? responses['default'] ?? (2xx ? 'json' : 'text')` で決める。2xx なら `decodeBody` → `op.transform` → `{ data, error: undefined, response }`。非 2xx なら body をデコードする（失敗時は生テキスト）→ `ApiError`。`throwOnError`（options > config > false）が true なら throw する。`DecodeError` と `TransportError` は throwOnError に関係なく常に throw する。
- `decodeBody('json')`: status 204 / 205 / 304、または body が空文字なら `undefined`。JSON.parse 失敗は `DecodeError`。
- transport: タイムアウトは `AbortController` + `setTimeout` で実装し、外部 `signal` と手動で連結する。タイムアウト時は `TransportError(timedOut: true)`、fetch の reject は `TransportError`。
- リダイレクト（spec §8.5）: `credentialHeaders`（`Authorization` 以外の apiKey ヘッダ / Cookie）か `credentialQuery` がリクエストに含まれ、かつ `typeof document === 'undefined'`（非ブラウザ）の場合だけ、`redirect: 'manual'` で最大 20 回まで手動で追跡する。オリジンが変わったら該当ヘッダ / クエリと `Authorization` を除去し、303（および POST に対する 301 / 302）は GET + body なしに変える。それ以外は `redirect: 'follow'`（fetch 仕様により cross-origin で Authorization は除去される）。

- [ ] **Step 1:** 失敗するテストを書く（`fetch` は差し替え可能な fake を使う）。
  - body: `encodes json/form/multipart/text/binary`（form は配列を繰り返しキーにする、multipart は Blob をそのまま、オブジェクトは JSON 文字列にする、ReadableStream は `replayable: false`）、`decodes empty json body as undefined`、`throws DecodeError on invalid json`。
  - client:
    - `builds URL with path, query and preserves baseUrl path`: baseUrl `https://x.test/api/` + `/foo/{id}` + `{id: 1}` + query → `https://x.test/api/foo/1?…`（Review Focus）
    - `returns {data,error:undefined} on 2xx`
    - `returns ApiError on 4xx with parsed body when throwOnError=false`
    - `throws ApiError when throwOnError=true`
    - `throws TransportError on fetch rejection and timeout`
    - `runs middleware in registration order outer-to-inner, auth innermost`: 記録用 middleware 2 つと、auth スタブが呼ばれた順序が `['mw1:before','mw2:before','auth','mw2:after','mw1:after']`
    - `client.use appends middleware`
    - `handles 204 and empty 200 as undefined data`
    - `applies op.transform to data`
  - transport: `manual redirect strips api key header on cross-origin hop`、`same-origin redirect keeps headers`、`303 converts to GET`（`node:http` で 2 つのオリジンを立てる）。
- [ ] **Step 2:** `pnpm -F @archon/runtime-typescript test` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。`pnpm -F @archon/runtime-typescript typecheck` も通ることを確認する。
- [ ] **Step 5:** Commit `feat(runtime-ts): add client, transport, body codec and middleware chain`。

## Task 15: TS runtime — 認証 / OAuth2 トークンマネージャ

**Files:**
- Create: `runtimes/typescript/src/{auth.ts,oauth2.ts,base64.ts}`
- Test: `runtimes/typescript/test/{auth,oauth2,base64}.test.ts`

**Interfaces:**
- Consumes: `ClientConfig`, `AuthConfig`, `SecurityRequirement`, `Middleware`, `AuthError`
- Produces:
  ```ts
  base64Encode(input: string): string;     // UTF-8 → base64。btoa 不使用
  type Selection = { kind: 'apply'; requirement: SecurityRequirement } | { kind: 'anonymous' } | { kind: 'missing'; schemes: string[] };
  selectRequirement(requirements: SecurityRequirement[], isConfigured: (scheme: string) => boolean): Selection;
  // TokenSet は types.ts に置く（Task 14 の OAuth2Value が参照するため）:
  // type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
  class OAuth2TokenManager {
    constructor(opts: { fetch: FetchLike; config: OAuth2Value; tokenUrl?: string; leewayMs?: number; now?: () => number });
    getToken(scopes: string[]): Promise<string>;
    invalidate(): void;
    readonly managed: boolean;                   // clientCredentials / refreshToken で取得する場合 true
  }
  createAuthMiddleware(getConfig: () => ClientConfig<any>): Middleware;
  ```
  `selectRequirement` の規則は spec §8.2 のとおり。`missing.schemes` には最初の非空要件の未設定スキームを入れる。
  auth middleware: 選択した要件の各スキームを適用する。bearer → `Authorization: Bearer <token>`、basic → `Authorization: Basic base64(user:pass)`、apiKey → header / query / Cookie に追記。oauth2 / openIdConnect → `accessToken` があればそれを使い、無ければ manager から取得する（scopes は要件の scopes）。`customAuth` があれば最後に呼ぶ。`missing` なら `AuthError` を throw する（送信しない）。manager 管理のトークンで 401 を受けたら、`req.replayable` の場合に限り `invalidate()` して 1 回だけ再送する。manager はスキームごとに作成してキャッシュし、`setConfig` で auth が変わったら作り直す。
  `OAuth2TokenManager`: clientCredentials → `grant_type=client_credentials&scope=<space区切り>`、refreshToken → `grant_type=refresh_token&refresh_token=…`。clientAuth `'basic'`（既定）は `Authorization: Basic`、`'post'` は body に `client_id` / `client_secret` を入れる。`expires_in` があれば `expiresAt = now + expires_in*1000`。`expiresAt - leewayMs(30_000) <= now` なら更新する。同時呼び出しは同じ Promise を共有する（single-flight）。キャッシュキーは scopes をソートして連結したもの。トークンエンドポイントの非 2xx は `AuthError`。refresh 応答に `refresh_token` があれば差し替えて `onRefreshed` を呼ぶ。`tokenUrl` は config > spec の値。どちらも無ければ `AuthError`。

- [ ] **Step 1:** 失敗するテストを書く。
  - base64: `'user:päss'` → `'dXNlcjpww6Rzcw=='`、空文字。
  - selectRequirement: `[]` → anonymous、`[[{bearer}],[]]` で未設定 → anonymous、`[[{bearer}]]` で未設定 → missing `['bearer']`、AND 要件の一部だけ設定 → 次の代替へ。
  - auth middleware: `applies bearer from async provider`、`applies basic`、`applies apiKey in header/query/cookie`、`throws AuthError before sending when required auth missing`（fake fetch が呼ばれないこと）、`re-applies fresh token on re-entry`（provider が呼ぶたびに別トークンを返し、2 回目の `next` で新トークンが付くこと）、`retries once on 401 with managed token`。
  - oauth2: `fetches client credentials token with basic client auth`、`caches until 30s before expiry then refreshes`（`now` を進める）、`single-flight concurrent getToken`（3 並行で token endpoint 呼び出し 1 回）、`refresh grant rotates refresh token and calls onRefreshed`、`AuthError on token endpoint failure`。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する（Task 14 の auth スタブを置き換える）。
- [ ] **Step 4:** ランタイムの全テストが PASS することを確認する。
- [ ] **Step 5:** Commit `feat(runtime-ts): add auth application and OAuth2 token manager`。

## Task 16: TS runtime — 標準 middleware

**Files:**
- Modify: `runtimes/typescript/src/middleware.ts`
- Test: `runtimes/typescript/test/middleware.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Logger = { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  loggingMiddleware(opts?: { logger?: Logger; level?: 'debug' | 'info'; redactHeaders?: string[]; redactQuery?: string[] }): Middleware;
  userAgentMiddleware(value: string): Middleware;
  retryMiddleware(opts?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; maxRetryAfterMs?: number;
                           statuses?: number[]; methods?: HttpMethod[]; retryOnNetworkError?: boolean;
                           sleep?: (ms: number) => Promise<void>; random?: () => number }): Middleware;
  retry401Middleware(opts: { onUnauthorized: (ctx: CallContext, response: Response) => boolean | Promise<boolean> }): Middleware;
  ```
  既定値: `maxAttempts 3`、`baseDelayMs 200`、`maxDelayMs 5000`、`maxRetryAfterMs 60000`、`statuses [408,429,500,502,503,504]`、`methods ['GET','HEAD','OPTIONS','PUT','DELETE']`、`retryOnNetworkError true`。遅延は `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * (0.5 + random()/2)`（full jitter ではなく equal jitter）。429 / 503 に `Retry-After`（秒数または HTTP-date）があれば、その値を `maxRetryAfterMs` で上限して使う。`replayable: false` のリクエストは再送しない。再送のたびに `ctx.attempt++` する。
  logging: 1 行目 `→ METHOD url`、2 行目 `← status (ms)`。マスク対象は `ctx.redact.headers` / `ctx.redact.query` と、既定の `authorization`, `cookie`, `proxy-authorization`, `set-cookie` と、opts の値（すべて小文字比較）。マスク後の値は `***`。
  retry401: 401 かつ `replayable` のとき `onUnauthorized` が true を返したら、`ctx.attempt++` して 1 回だけ再送する。

- [ ] **Step 1:** 失敗するテストを書く: `retries 503 with Retry-After seconds then succeeds`（sleep spy に 1000 が渡る）、`does not retry POST by default`、`does not retry non-replayable request`、`stops after maxAttempts`、`retries network errors`、`equal jitter delay bounds`、`retry401 calls onUnauthorized and retries once with fresh auth`（Task 15 の auth middleware と組み合わせて Authorization が新トークンになること）、`logging masks authorization and api key query`、`userAgent sets header`。
- [ ] **Step 2:** テストを実行 → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(runtime-ts): add logging, user-agent, retry and retry401 middleware`。

## Task 17: TS plugin — 型出力（types.gen.ts）と symbols

**Files:**
- Create: `packages/archon/src/plugins/typescript/{index.ts,types.ts,reserved.ts}`, `packages/archon/src/plugins.ts`
- Test: `packages/archon/test/plugins/typescript/types.test.ts`

**Interfaces:**
- Consumes: `definePlugin`, `CodeWriter`, `toCase`, `UniqueNamer`, IR
- Produces:
  ```ts
  type NamingRule = { case?: NameCase; name?: string | ((name: string) => string) };
  interface TypeScriptPluginOptions {
    output: string;                                       // 既定 'typescript'
    package: false | { name: string; version: string; description?: string; license?: string };  // 既定: name=toCase(info.title,'kebab-case'), version=info.version
    sdk: { style: 'functions' | 'class' };               // 既定 functions
    enums: 'union' | 'const' | 'enum';                   // 既定 union
    dates: 'string' | 'Date';                            // 既定 string
    importExtension: '.js' | '.ts' | '';                 // 既定 '.js'
    naming: { type?: NamingRule; method?: NamingRule; file?: NamingRule };   // 既定 type PascalCase, method camelCase
    typeMappings: Record<string, string>;                // キー 'string:uuid' 形式、値は TS 型式
    hooks: { typeName?: (name: string) => string | undefined; methodName?: (op: IROperation) => string | undefined;
             typeOverride?: (schema: IRSchema, ctx: { path: SchemaPath }) => string | undefined };
    include?: string[]; exclude?: string[];
  }
  interface TypeScriptPluginAPI {
    symbols: {
      typeOf(schemaName: string): { name: string; file: string };   // file は outputDir 相対（例 'types.gen.ts'）
      operation(operationId: string): { functionName: string; dataType: string; responseType: string; errorType: string; file: string };
    };
  }
  const typescript: (options?: DeepPartial<TypeScriptPluginOptions>) => ArchonPlugin<TypeScriptPluginOptions, TypeScriptPluginAPI>;
  // types.ts（内部）
  renderTypes(ctx: PluginContext<TypeScriptPluginOptions>, names: TypeNameTable): string;
  schemaToTs(schema: IRSchema, names: TypeNameTable, opts: TypeScriptPluginOptions, path: SchemaPath): string;
  ```
  `irRequirements`: `{ hoistInlineObjects: false, hoistInlineEnums: opts.enums !== 'union' }`。
  型マッピング: string → `string`（`date-time` / `date` は dates==='Date' なら `Date`）、integer / number → `number`、boolean、null → `null`、array → `T[]`（union / intersection の要素は括弧で囲む）、tuple → `[A, B, ...R[]]`、object → `{ ... }` リテラル（required でなければ `?`、additionalProperties は `[key: string]: T`。プロパティ型と互換でなければ `unknown` にする）、enum → リテラル union（enums が const / enum のときは named enum のみ宣言を変え、inline enum はリテラル union のまま）、const → リテラル、union → `A | B`、intersection → `A & B`、ref → 型名、binary → `Blob`、unknown → `unknown`。nullable → `T | null`。`typeMappings['kind:format']` と `hooks.typeOverride` が最優先。
  宣言: named schema ごとに `export type X = …;`（enums==='const' は `export const X = {…} as const; export type X = typeof X[keyof typeof X];`、'enum' は `export enum X {…}`。enum メンバー名は値の PascalCase、数字始まりは `_` を前置、衝突は UniqueNamer）。description / deprecated は JSDoc（`@deprecated`）にする。
  識別子: プロパティ名が `/^[A-Za-z_$][A-Za-z0-9_$]*$/` に一致しなければ `'…'` で引用する。型名は `toCase(name,'PascalCase')`、先頭が数字なら `_` を前置、TS 予約語（`reserved.ts`）と衝突すれば `_` を後置する。名前の重複は UniqueNamer（case-sensitive）で解決する。

- [ ] **Step 1:** 失敗するテストを書く（小さな IR を手で組み、`renderTypes` の出力を文字列で比較する）。
  - `renders object with optional and nullable properties`: `export type Pet = {\n  id: number;\n  name?: string | null;\n};`
  - `renders union of refs and nullable array`
  - `renders enums as union / const / enum per option`
  - `quotes invalid property identifiers and sanitizes type names`: プロパティ `x-foo` / `2fa` / `with space` が引用符付きキー、schema 名 `Foo.Bar` → `FooBar`、`1Thing` → `_1Thing`、`foo-bar` → `FooBar`（衝突時は `FooBar2`）（Review Focus）
  - `renders self-referencing schema by name`: `export type Comment = {\n  replies?: Comment[];\n};`（Review Focus）
  - `applies typeMappings and typeOverride`
  - `maps date-time to Date when dates=Date`
  - `emits JSDoc with @deprecated`
  - `symbols.typeOf returns sanitized name`
- [ ] **Step 2:** `pnpm test packages/archon/test/plugins/typescript/types.test.ts` → FAIL。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-ts): emit TypeScript types`。

## Task 18: TS plugin — sdk.gen.ts / client.gen.ts / package / runtime copy / transformers

**Files:**
- Create: `packages/archon/src/plugins/typescript/{sdk.ts,client.ts,transformers.ts,package.ts,runtime.ts}`, `packages/archon/scripts/copy-runtimes.mjs`
- Modify: `packages/archon/src/plugins/typescript/index.ts`, `packages/archon/package.json`（`build` の前に copy-runtimes を実行、`files` に `runtimes`）
- Test: `packages/archon/test/plugins/typescript/{sdk,client,runtime}.test.ts`

**Interfaces:**
- Consumes: Task 13–16 のランタイム公開 API（名前を文字列として生成コードに埋め込む）、Task 17 の `TypeNameTable` / `schemaToTs`
- Produces（生成物の構造。E2E とカスタムプラグインが依存する）:
  ```
  <outputDir>/
    core/*.ts          # runtimes/typescript/src/*.ts のコピー（import 拡張子を importExtension に書き換える）
    types.gen.ts       # Task 17
    sdk.gen.ts
    client.gen.ts
    transformers.gen.ts   # dates==='Date' のときのみ
    index.ts           # export * from './types.gen.js', './sdk.gen.js', './client.gen.js', './core/index.js'
    package.json, tsconfig.json   # package !== false のとき
  ```
  `resolveRuntimeDir(language: string): string` — `<pkgRoot>/runtimes/<language>/src`（build 済み配布物）→ `<repoRoot>/runtimes/<language>/src`（開発時）の順に探す。どちらも無ければ `ArchonError('runtime-missing')`。
  client.gen.ts:
  ```ts
  export const securitySchemes = { bearerAuth: { type: 'http', scheme: 'bearer' } } as const satisfies Record<string, SecuritySchemeSpec>;
  export type ApiAuth = { bearerAuth?: TokenValue; basicAuth?: BasicValue; apiKey?: TokenValue; oauth2?: OAuth2Value };   // スキームの種類ごとに型を選ぶ
  export const defaultBaseUrl = 'https://api.natsuneko.com';   // servers[0]、変数は default で展開
  export const createApiClient = (config: Partial<ClientConfig<ApiAuth>> = {}): Client<ApiAuth> => createClient<ApiAuth>({ baseUrl: defaultBaseUrl, securitySchemes, ...config });
  export const client = createApiClient();
  ```
  oauth2 スキームの `tokenUrl` / `refreshUrl` は flows.clientCredentials → authorizationCode → password の順で最初に見つかったものを `securitySchemes` に入れる。
  sdk.gen.ts（functions スタイル。操作ごと）:
  ```ts
  export type GetFooByIdData = { path: { id: string }; query?: { limit?: number }; headers?: { 'x-trace'?: string }; cookies?: {…}; body?: … };
  export type GetFooByIdResponses = { 200: Foo };
  export type GetFooByIdResponse = GetFooByIdResponses[keyof GetFooByIdResponses];   // 2xx のみ。無ければ unknown。204 は void
  export type GetFooByIdErrors = { 404: NotFound; default: unknown };
  export type GetFooByIdError = GetFooByIdErrors[keyof GetFooByIdErrors];               // 無ければ unknown
  const getFooByIdSpec: OperationSpec = { operationName: 'getFooById', method: 'GET', path: '/foo/{id}', tags: [...], security: [...], params: [...], body?: …, responses: {...}, transform?: … };
  /** summary / description / @deprecated */
  export const getFooById = <ThrowOnError extends boolean = false>(options: Options<GetFooByIdData, ThrowOnError>) =>
    (options.client ?? client).request<GetFooByIdResponse, GetFooByIdError, ThrowOnError>(getFooByIdSpec, options);
  ```
  `Options<TData, ThrowOnError> = TData & { client?: Client<any>; signal?: AbortSignal; throwOnError?: ThrowOnError; extensions?: Record<string, unknown>; baseUrl?: string }` を sdk.gen.ts 冒頭で定義する。必須フィールド（path、required query / header、required body）が 1 つも無い操作は `options: … = {}` にする。Data の `query` / `headers` / `cookies` は、必須パラメータを含むときだけ必須にする。body の型は採用した media type の schema（multipart / form も同じ object 型）。
  プラグインの `include` / `exclude`（`matchesPattern` で `op.id` と照合。exclude 優先）に一致しない操作は sdk.gen.ts に出力しない（型は出力する）。
  class スタイル: group（無ければ `Default`）ごとに `export class <PascalGroup> { static <method> = <関数式>; }`。型と spec 定数は functions スタイルと同じ。
  transformers.gen.ts: date-time / date を含む schema ごとに `transform<Name>(data: any): any` を生成し、`new Date(...)` へ変換する（ref は再帰呼び出し。循環は関数参照なので問題ない）。操作 spec の `transform` に、成功レスポンス型用の transformer を設定する。

- [ ] **Step 1:** 失敗するテストを書く。
  - sdk: `plugin include/exclude limits generated operations`
  - sdk: `generates data/response/error types and spec constant`（petstore 相当の小さな IR で `sdk.gen.ts` の該当部分を `toContain` で確認する）、`makes options optional when nothing is required`、`class style groups by tag`、`uses methodName hook`、`omits body for GET and includes body kind for multipart`。
  - client: `emits securitySchemes, ApiAuth types per scheme kind and defaultBaseUrl with server variables expanded`。
  - runtime: `copies runtime files and rewrites import extensions`（importExtension `''` で `from './types'`）、`resolveRuntimeDir finds repo runtimes in dev`。
  - package: `emits package.json with name/version and tsconfig`、`package false skips manifests`。
  - transformers: `dates=Date generates transformer and wires it into spec`。
- [ ] **Step 2:** `pnpm test packages/archon/test/plugins/typescript` → FAIL。
- [ ] **Step 3:** 実装する。生成 package.json は `{ "type": "module", "exports": { ".": "./index.ts" } … }` とし、dependencies を持たない。tsconfig は Global Constraints の設定に `noEmit: true` を加えたもの。
- [ ] **Step 4:** PASS を確認する。
- [ ] **Step 5:** Commit `feat(plugin-ts): emit sdk, client, transformers and vendored runtime`。

## Task 19: Fixtures・スナップショット・コンパイルテスト

**Files:**
- Create: `fixtures/specs/petstore.yaml`, `fixtures/specs/edge-cases.yaml`, `packages/archon/test/e2e-generate/{snapshot,compile}.test.ts`
- Test: 上記

**Interfaces:**
- Produces: `edge-cases.yaml`（OpenAPI 3.1.0、Task 20 のモックサーバと E2E が実装・利用する）。servers `[{ url: 'http://localhost:{port}', variables: { port: { default: '4010' } } }]`。必須エンドポイント（operationId はすべて明示する）:

  | operationId | method / path | 狙い |
  |---|---|---|
  | `echoPathStyles` | GET `/echo/path/{simple}/{label}/{matrix}` | path の simple / label / matrix（explode 混在）。レスポンスは Echo |
  | `echoQueryStyles` | GET `/echo/query` | form（explode true / false）, spaceDelimited, pipeDelimited, deepObject, allowReserved |
  | `echoHeadersCookies` | GET `/echo/headers` | header パラメータ（array simple）と cookie パラメータ |
  | `echoJson` / `echoForm` / `echoMultipart` / `echoBinary` / `echoText` | POST `/echo/body/{kind}` | 各 body 種別。multipart はファイル + フィールド |
  | `getText` / `getBinary` / `getEmpty` / `getEmptyJson` | GET `/responses/{text,binary,empty,empty-json}` | text, octet-stream, 204, 200 で空 body の JSON |
  | `listShapes` | GET `/unions/shapes` | 判別あり union（`kind: circle/square`）と未知の `kind: hexagon` |
  | `listPets` | GET `/unions/untagged` | 判別なし anyOf |
  | `getEnumValues` | GET `/enums` | 既知の値と未知の enum 値 |
  | `getDates` | GET `/dates` | date-time / date のプロパティ（ネストした配列内を含む） |
  | `getError` | GET `/errors/{status}` | 400 / 404 / default の型付きエラー |
  | `authBearer` / `authBasic` / `authApiKeyHeader` / `authApiKeyQuery` / `authApiKeyCookie` / `authOAuth2` / `authOptional` / `authAnd` | GET `/auth/*` | 各 auth、`[{}]` を含む任意認証、AND 要件 |
  | `flaky` | GET `/flaky/{key}` | `?fail=N` 回 503 + `Retry-After: 0` の後 200 |
  | `redirectCrossOrigin` | GET `/redirect/cross-origin` | 別ポートの echo へ 302（apiKey ヘッダの除去確認） |
  | `createNode` | POST `/nodes` | readOnly `id` を持つ自己参照 `Node`（children: Node[]）、allOf 合成 |

  Echo レスポンス schema: `{ method: string, path: string, query: string, headers: Record<string,string>, cookies: Record<string,string>, contentType?: string, body?: string, files?: { field: string; name: string; size: number }[] }`（path / query は生文字列）。
  securitySchemes: `bearerAuth`（http bearer）、`basicAuth`（http basic）、`apiKeyHeader`（`X-API-Key`）、`apiKeyQuery`（`api_key`）、`apiKeyCookie`（`session`）、`oauth2`（clientCredentials tokenUrl `/oauth/token`、scopes `read`, `write`）。petstore.yaml は 3.0.3 で `listPets` / `createPet` / `showPetById`、`nullable: true`、`Error` schema を含むものにする。

- [ ] **Step 1:** fixtures を書く。
- [ ] **Step 2:** 失敗するテストを書く。
  - snapshot: petstore と edge-cases を `generate()` で一時ディレクトリに生成し、`core/` 以外の各ファイルを `expect(content).toMatchFileSnapshot('__snapshots__/<spec>/<file>')` で比較する。初回実行時は snapshot を作成し、目視確認した上でコミットする。
  - compile: petstore / edge-cases / natsuneko を生成し、生成された tsconfig で `tsc -p <dir> --noEmit` を実行して終了コード 0 を assert する（natsuneko は 3 種類のオプション: 既定、`enums:'enum'` + `sdk.style:'class'`、`dates:'Date'` + `importExtension:'.ts'`）。
- [ ] **Step 3:** `pnpm test packages/archon/test/e2e-generate` → snapshot 作成 / compile の失敗を確認し、生成側を修正して通す。
- [ ] **Step 4:** 生成された snapshot を目視確認する（型名・JSDoc・Options の必須性）。`pnpm test` で全テストが PASS することを確認する。
- [ ] **Step 5:** Commit `test: add fixtures, snapshot and compile tests for TypeScript output`。

## Task 20: モックサーバと TypeScript E2E

**Files:**
- Create: `e2e/mock-server/{package.json,tsconfig.json,src/server.ts,src/routes/{echo,responses,unions,auth,oauth,flaky,redirect,errors,nodes}.ts}`, `e2e/typescript/{package.json,vitest.config.ts,global-setup.ts,test/{params,bodies,responses,unions,auth,middleware,errors,redirect}.test.ts}`
- Test: 上記

**Interfaces:**
- Consumes: `fixtures/specs/edge-cases.yaml`、`generate()`、生成 SDK（`e2e/typescript/generated/index.ts`）
- Produces:
  ```ts
  // e2e/mock-server/src/server.ts
  startMockServer(opts?: { port?: number }): Promise<{ url: string; secondaryUrl: string; close(): Promise<void> }>;
  // secondaryUrl は別ポートの echo 専用サーバ（cross-origin 確認用）
  ```
  資格情報の期待値（サーバ側の固定値）: bearer `test-token`、basic `user` / `pass`、apiKey 各 `test-key`、oauth2 client `client-id` / `client-secret`。トークンは `expires_in: 2` で発行し、期限切れは 401 にする。`/oauth/token` は client_credentials / refresh_token の両方に対応し、発行回数を `GET /__stats` で返す。
  global-setup は、モックサーバを起動 → `generate({ input: fixtures/specs/edge-cases.yaml, output: 'e2e/typescript/generated', plugins: [typescript({ output: '.', package: false })] })` → `provide('baseUrl', url)` / `provide('secondaryUrl', …)` を行う。

- [ ] **Step 1:** モックサーバを実装する（node:http のみ、ルート単位のファイル）。`pnpm -F @archon/e2e-mock-server typecheck` が通ることを確認する。
- [ ] **Step 2:** E2E テストを書く（全テストで `createApiClient({ baseUrl })` を使う）。
  - params: `serializes all path styles`（Echo.path が Task 13 の表どおり）、`serializes all query styles`、`sends header array and cookies`。
  - bodies: json / form / multipart（ファイル名とサイズ）/ binary / text の Echo 内容。
  - responses: text / binary（Blob のサイズ）/ 204 → `data === undefined` / 空 JSON → `data === undefined`。
  - unions: 判別あり union を `kind` で narrowing でき、未知の `hexagon` もそのまま値として受け取れる（例外にならない）。判別なしも同様。enums: 未知値を受け取れる。dates: `dates:'Date'` で別途生成したクライアントで `instanceof Date`（ネスト配列内を含む）。
  - auth: 各スキームで 200。必須 auth 未設定は `AuthError` を throw し、サーバにリクエストが届かない（`/__stats` で確認）。`authOptional` は未設定でも 200。`authAnd` は片方だけでは `AuthError`。oauth2 は clientCredentials で 200、2 秒待って再呼び出しすると先回り更新でトークン発行回数が 2、並行 5 リクエストでも発行は 1 回。
  - middleware: retry で `/flaky/k?fail=2` が 200、retry401 + 手動トークン差し替え、logging のマスク、userAgent の Echo、登録順。
  - errors: 404 で `error.status === 404` と型付き body、throwOnError で `ApiError` を throw。
  - redirect: `apiKeyHeader` を付けて `/redirect/cross-origin` を呼ぶと、secondary の Echo に `x-api-key` も `authorization` も無い。
- [ ] **Step 3:** `pnpm -F @archon/e2e-typescript test` を実行し、失敗をランタイム / プラグインの修正で解消する（テスト側の期待値は spec に合わせ、緩めない）。
- [ ] **Step 4:** root で `pnpm test` → 全 PASS、`pnpm typecheck` → 0 エラーを確認する。
- [ ] **Step 5:** Commit `test: add mock server and TypeScript end-to-end suite`。

## Task 21: ライブスモークと README

**Files:**
- Create: `scripts/live-smoke.ts`, `README.md`, `examples/natsuneko/archon.config.ts`
- Test: 手動実行

**Interfaces:**
- Consumes: CLI、生成 SDK

- [ ] **Step 1:** `examples/natsuneko/archon.config.ts` を書く（input は natsuneko の URL、`typescript({ output: 'ts' })`）。
- [ ] **Step 2:** `scripts/live-smoke.ts` を書く。examples の設定で生成し、security が無い（IR で `security: []` の）GET 操作のうち、必須パラメータの無いものを 3 つ選んで呼び、HTTP 200 と、`data` が `undefined` でないことを確認する。node 24 の `--experimental-strip-types` で実行できる形にする。
- [ ] **Step 3:** `node --experimental-strip-types scripts/live-smoke.ts` を実行し、3 件とも成功することを確認する（ネットワーク不可なら結果をそのまま報告する）。
- [ ] **Step 4:** README に、インストール、`archon init` / `archon generate`、設定例（spec §5.1）、生成 SDK の使い方（createApiClient, auth, middleware, throwOnError）、カスタムプラグインの最小例、M2 以降のロードマップを書く。
- [ ] **Step 5:** Commit `docs: add README, example config and live smoke script`。
