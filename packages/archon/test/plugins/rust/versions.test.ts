import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQWEST_VERSION, RUST_VERSION, SERDE_JSON_VERSION, SERDE_VERSION, TOKIO_VERSION } from '../../../src/plugins/rust/project.js';

const path = (p: string) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));

describe('rust plugin: versions', () => {
  it("runtime and e2e manifests use the plugin's version constants", () => {
    const runtime = readFileSync(path('runtimes/rust/Cargo.toml'), 'utf8');
    expect(runtime).toContain(`rust-version = "${RUST_VERSION}"`);
    expect(runtime).toContain(`reqwest = { version = "${REQWEST_VERSION}", default-features = false }`);
    expect(runtime).toContain(`serde = { version = "${SERDE_VERSION}", features = ["derive"] }`);
    expect(runtime).toContain(`serde_json = { version = "${SERDE_JSON_VERSION}", features = ["preserve_order"] }`);
    expect(runtime).toContain(`tokio = { version = "${TOKIO_VERSION}", features = ["time", "sync"] }`);

    // The E2E crate gets reqwest / serde from the generated SDK; it adds tokio's runtime and serde_json for assertions.
    if (!existsSync(path('e2e/rust/Cargo.toml'))) return;
    const e2e = readFileSync(path('e2e/rust/Cargo.toml'), 'utf8');
    expect(e2e).toContain(`tokio = { version = "${TOKIO_VERSION}"`);
    expect(e2e).toContain(`serde_json = "${SERDE_JSON_VERSION}"`);
  });
});
