import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOTLIN_VERSION, KTOR_VERSION, SERIALIZATION_VERSION } from '../../../src/plugins/kotlin/project.js';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../../${path}`, import.meta.url)), 'utf8');

describe('kotlin plugin: versions', () => {
  it("runtime and e2e builds use the plugin's version constants", () => {
    const runtime = read('runtimes/kotlin/build.gradle.kts');
    expect(runtime).toContain(`kotlin("jvm") version "${KOTLIN_VERSION}"`);
    expect(runtime).toContain(`kotlin("plugin.serialization") version "${KOTLIN_VERSION}"`);
    expect(runtime).toContain(`io.ktor:ktor-client-core:${KTOR_VERSION}`);
    expect(runtime).toContain(`org.jetbrains.kotlinx:kotlinx-serialization-json:${SERIALIZATION_VERSION}`);

    // The E2E project gets ktor-client-core and kotlinx-serialization-json from the generated SDK; it adds an engine.
    const e2ePath = fileURLToPath(new URL('../../../../../e2e/kotlin/build.gradle.kts', import.meta.url));
    if (!existsSync(e2ePath)) return;
    const e2e = read('e2e/kotlin/build.gradle.kts');
    expect(e2e).toContain(`kotlin("jvm") version "${KOTLIN_VERSION}"`);
    expect(e2e).toContain(`io.ktor:ktor-client-cio:${KTOR_VERSION}`);
  });
});
