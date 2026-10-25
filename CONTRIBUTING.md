# Contributing to Archon

## Setup

The repository is a pnpm workspace. You need Node.js 24 and pnpm 10.

```sh
pnpm install
pnpm -F @natsuneko-laboratory/archon build   # builds the CLI (packages/archon/dist/cli.js)
```

After building, any workspace package that has `@natsuneko-laboratory/archon` as a devDependency can run the CLI,
for example `examples/natsuneko`:

```sh
cd examples/natsuneko && pnpm exec archon generate   # → examples/natsuneko/sdk/ts/
```

## Repository layout

| Path               | Contents                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `packages/archon`  | The published package: core (loader, parser, IR, passes, config, plugin API, CLI) and the language plugins |
| `runtimes/<lang>`  | The handwritten runtimes. `pnpm build` copies them into `packages/archon/runtimes` so they ship with the package |
| `e2e/`             | A shared mock server and E2E suites that run the same scenarios against each generated SDK |
| `fixtures/specs`   | OpenAPI specs used by the snapshot, compile and E2E tests                                  |
| `examples/`        | Example configurations                                                                     |
| `docs/superpowers` | The design document and per-milestone implementation plans (in Japanese)                  |

## Tests

```sh
pnpm test        # unit, snapshot and generated-code compile tests (vitest)
pnpm typecheck   # tsc --noEmit for every package
pnpm build       # build every package

pnpm test:e2e          # E2E: generated TypeScript SDK against the mock server (e2e/typescript)
pnpm test:e2e:csharp   # same scenarios with the generated C# SDK (e2e/csharp; needs the .NET 10 SDK)
pnpm test:e2e:kotlin   # same scenarios with the generated Kotlin SDK (e2e/kotlin; needs JDK 17+)
pnpm test:e2e:swift    # same scenarios with the generated Swift SDK (e2e/swift; needs Swift 6.1+)
pnpm test:e2e:rust     # same scenarios with the generated Rust SDK (e2e/rust; needs cargo)
pnpm test:e2e:go       # same scenarios with the generated Go SDK (e2e/go; needs Go 1.22+)
pnpm -F @natsuneko-laboratory/archon-e2e-typescript smoke bun   # run the generated SDK on Bun (or `smoke deno`)

# Runtime unit tests
dotnet test runtimes/csharp/tests/Archon.Runtime.Tests
runtimes/kotlin/gradlew -p runtimes/kotlin test       # the Gradle wrapper is included
swift test --package-path runtimes/swift              # swift-testing
cargo test --manifest-path runtimes/rust/Cargo.toml
(cd runtimes/go && go test -race ./...)
```

The compile tests for generated code are skipped when the toolchain is missing:

- C# (`dotnet build -warnaserror`) needs the .NET 10 SDK or later.
- Kotlin (`gradle build`, warnings as errors) needs JDK 17 or later.
- Swift (`swift build -Xswiftc -warnings-as-errors`) needs Swift 6 or later.
- Rust (`cargo clippy -- -D warnings`) needs `cargo`.

To try a generated Kotlin SDK locally, run `runtimes/kotlin/gradlew -p <output dir> build`.

## CI

CI (`.github/workflows/ci.yml`) runs all of the above. It installs the toolchains with `actions/setup-dotnet`,
`actions/setup-java` and `dtolnay/rust-toolchain`. It also runs the TypeScript runtime unit tests on Node.js 18, 20,
22 and 24, smoke tests the generated TypeScript SDK on Bun and Deno, and runs the Swift runtime tests and E2E on both
Linux (the `swift:6.2` container) and macOS.

## Live smoke test (manual)

This test calls the real `api.natsuneko.com` API through a generated SDK (needs network access). It generates an SDK
into a temporary directory from `examples/natsuneko/archon.config.ts`. It then calls up to three `GET` operations that
need no authentication or only optional authentication (`{}`) and have no required parameters. It checks for HTTP 200
and a defined `data`, and exits with a non-zero status if any call fails.

```sh
node --experimental-strip-types scripts/live-smoke.ts
```

You can also run it from the `Live smoke` GitHub Actions workflow (`workflow_dispatch` only).

Operations with `security: []` come first, then operations with optional authentication fill the remaining slots.
Operations whose real behavior differs from the spec are listed, with a reason, in `KNOWN_SPEC_MISMATCHES` in
`scripts/live-smoke.ts`. They are excluded and shown as `skip` (currently `GET /feature-flags/v1/me`: the spec says no
authentication, but the real API returns 401). Only two operations in the natsuneko spec currently qualify
(`/catalyst/v1/announcements` and `/catalyst/v1.1/timeline/newcomers`, which has optional authentication). So the
test passes with two or more operations and prints a note when there are fewer than three.

Archon's sources use relative imports with `.js` extensions, which Node's type stripping alone cannot load. The script
therefore loads the sources and the generated SDK through jiti, so you do not need to run `pnpm build` first.
