import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../../src/generate.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import type { FiltersConfig } from '../../src/passes/filters.js';
import type { DeepPartial } from '../../src/plugin/define.js';
import { kotlin, type KotlinPluginOptions } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
const gradlew = fileURLToPath(new URL(`../../../../runtimes/kotlin/gradlew${process.platform === 'win32' ? '.bat' : ''}`, import.meta.url));
const initScript = fileURLToPath(new URL('./kotlin-warnings.init.gradle.kts', import.meta.url));

/** The build needs JDK 17+ (the generated code itself targets JVM 11). */
const hasJava17 = (() => {
  const version = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const major = Number(/version "(\d+)/.exec(`${version.stderr}${version.stdout}`)?.[1]);
  return version.status === 0 && major >= 17;
})();

type Case = { name: string; spec: string | OpenAPIDocument; options?: DeepPartial<KotlinPluginOptions>; filters?: FiltersConfig };

const obj = (props: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, required, ...extra });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Schemas named after types the generated code uses, nested names of unions, Kotlin keywords and JVM getter clashes,
 * comment delimiters and `$` in descriptions, unions referring to each other, and a self-referencing tree.
 */
const stress: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Stress', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/things': {
      post: {
        operationId: 'postThings',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Circle') } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Holder') } } } },
      },
    },
    '/things/{class}': {
      get: {
        operationId: 'getThing',
        description: 'Reads */ one /* thing for $name.',
        parameters: [
          { name: 'class', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'when', in: 'query', schema: { type: 'string' } },
          { name: 'values', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Weird') } } } },
      },
    },
  },
  components: {
    schemas: {
      ...Object.fromEntries(
        ['Task', 'Type', 'Exception', 'String', 'List', 'Result', 'Unit', 'Any', 'ApiRequest', 'Serializable', 'Json', 'Unknown', 'Serializer', 'Companion'].map((n) => [
          n,
          obj({ a: { type: 'string' } }),
        ]),
      ),
      U1: { oneOf: [ref('U2'), { type: 'string' }] },
      U2: { oneOf: [ref('U1'), { type: 'integer' }] },
      Shape: { oneOf: [ref('Circle'), ref('Square')], discriminator: { propertyName: 'kind' } },
      Circle: obj({ kind: { const: 'Circle' }, r: { type: 'number' } }, ['kind', 'r']),
      Square: obj({ kind: { type: 'string', enum: ['Square'] }, s: { type: 'number' } }, ['kind', 's']),
      Mixed: { oneOf: [ref('Shape'), ref('Circle'), ref('Unknown'), ref('Serializer'), { type: 'array', items: ref('String') }] },
      Holder: obj({ task: ref('Task'), type: ref('Type'), u: ref('U1'), m: ref('Mixed'), s: ref('String'), l: ref('List'), r: ref('Result') }),
      Weird: obj(
        {
          class: { type: 'string' },
          when: { type: 'string' },
          'x-foo': { type: 'string' },
          '2fa': { type: 'boolean' },
          foo_bar: { type: 'string' },
          fooBar: { type: 'string' },
          FooBar: { type: 'string' },
          price: { type: 'string', description: 'Costs $5 */ or /* $total' },
          status: { type: 'string', enum: ['value', 'is-known', 'serializer', '', 'Companion'] },
        },
        ['class'],
        { description: 'A */ weird /* schema with $name and ${x}.' },
      ),
      Node: obj({ id: { type: 'string' }, children: { type: 'array', items: ref('Node') } }, ['id', 'children']),
      Old: obj({ a: { type: 'string', deprecated: true } }, [], { deprecated: true }),
      UsesOld: obj({ old: ref('Old') }),
    },
  },
};

const cases: Case[] = [
  { name: 'stress (reserved names, keywords, cyclic and mixed unions)', spec: stress },
  { name: 'petstore', spec: 'petstore.yaml' },
  { name: 'edge-cases', spec: 'edge-cases.yaml' },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json' },
  {
    name: 'natsuneko (packageName, clientName, Long integers)',
    spec: 'natsuneko.json',
    options: { packageName: 'com.natsuneko.api', clientName: 'NatsunekoClient', typeMappings: { integer: 'Long' } },
  },
  { name: 'natsuneko (schemas include /^Album/)', spec: 'natsuneko.json', filters: { schemas: { include: ['/^Album/'] } } },
];

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!hasJava17)('compile: generated Kotlin SDK builds with gradle build and warnings as errors', () => {
  it.each(cases)('$name', async ({ spec, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-kt-compile-'));
    try {
      const out = join(dir, 'out');
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: out,
          ...(filters && { parser: { filters } }),
          plugins: [kotlin({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const { code, output } = await run(gradlew, ['-p', out, 'build', '--init-script', initScript, '--console=plain', '-q'], dir);
      const problems = output.split('\n').filter((l) => /^[ew]: /.test(l));
      expect({ code, problems: [...new Set(problems)].slice(0, 40) }, code === 0 ? '' : output.slice(-4000)).toEqual({ code: 0, problems: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
