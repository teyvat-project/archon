import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOTLIN_VERSION, KTOR_VERSION, SERIALIZATION_VERSION } from '../../../src/plugins/kotlin/project.js';

const repo = (path: string) => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url));

describe('kotlin plugin: versions', () => {
  it("runtime and e2e builds use the plugin's version constants", () => {
    for (const path of ['runtimes/kotlin/build.gradle.kts', 'e2e/kotlin/build.gradle.kts']) {
      if (path.startsWith('e2e') && !existsSync(repo(path))) continue;
      const build = readFileSync(repo(path), 'utf8');
      expect(build, path).toContain(`kotlin("jvm") version "${KOTLIN_VERSION}"`);
      expect(build, path).toContain(`kotlin("plugin.serialization") version "${KOTLIN_VERSION}"`);
      expect(build, path).toContain(`io.ktor:ktor-client-core:${KTOR_VERSION}`);
      expect(build, path).toContain(`org.jetbrains.kotlinx:kotlinx-serialization-json:${SERIALIZATION_VERSION}`);
    }
  });
});
