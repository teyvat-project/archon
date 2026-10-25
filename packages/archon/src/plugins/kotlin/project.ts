import type { PluginContext } from '../../plugin/types.js';
import { toCase } from '../../writer/naming.js';
import { literal } from './emit.js';
import type { KotlinPluginOptions } from './index.js';

// The only place these versions are written for generated SDKs; a test keeps runtimes/kotlin and e2e/kotlin in step.
export const KOTLIN_VERSION = '2.4.21';
export const KTOR_VERSION = '3.6.0';
export const SERIALIZATION_VERSION = '1.11.0';

/** `build.gradle.kts` and `settings.gradle.kts`, or nothing when `package` is `false`. */
export function renderProject(ctx: PluginContext<KotlinPluginOptions>, packageName: string): { file: string; content: string }[] {
  const pkg = ctx.options.package;
  if (pkg === false) return [];
  const header = ctx.writer().comment(ctx.headerLines('kotlin'), 'line').toString();
  const withHeader = (lines: string[]) => `${header === '' ? '' : `${header}\n`}${lines.join('\n')}\n`;
  const name = pkg?.name ?? (toCase(ctx.ir.info.title, 'kebab-case') || 'api');
  const description = pkg?.description ?? ctx.ir.info.description;

  const settings = [
    'pluginManagement {',
    '    repositories {',
    '        mavenCentral()',
    '        gradlePluginPortal()',
    '    }',
    '}',
    '',
    'dependencyResolutionManagement {',
    '    repositories {',
    '        mavenCentral()',
    '    }',
    '}',
    '',
    `rootProject.name = ${literal(name)}`,
  ];
  const build = [
    'import org.jetbrains.kotlin.gradle.dsl.JvmTarget',
    '',
    'plugins {',
    `    kotlin("jvm") version "${KOTLIN_VERSION}"`,
    `    kotlin("plugin.serialization") version "${KOTLIN_VERSION}"`,
    '    `java-library`',
    '}',
    '',
    `group = ${literal(pkg?.group ?? packageName)}`,
    `version = ${literal(pkg?.version ?? ctx.ir.info.version)}`,
    ...(description ? [`description = ${literal(description)}`] : []),
    '',
    'dependencies {',
    `    api("io.ktor:ktor-client-core:${KTOR_VERSION}")`,
    `    api("org.jetbrains.kotlinx:kotlinx-serialization-json:${SERIALIZATION_VERSION}")`,
    ...(pkg?.dependencies ?? []).map((d) => `    implementation(${literal(d)})`),
    '}',
    '',
    'java {',
    '    sourceCompatibility = JavaVersion.VERSION_11',
    '    targetCompatibility = JavaVersion.VERSION_11',
    '}',
    '',
    'kotlin {',
    '    explicitApi()',
    '    compilerOptions {',
    '        jvmTarget.set(JvmTarget.JVM_11)',
    '        freeCompilerArgs.add("-Xjdk-release=11")',
    '    }',
    '}',
  ];
  return [
    { file: 'settings.gradle.kts', content: withHeader(settings) },
    { file: 'build.gradle.kts', content: withHeader(build) },
  ];
}
