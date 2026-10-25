import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../../src/generate.js';
import type { FiltersConfig } from '../../src/passes/filters.js';
import type { DeepPartial } from '../../src/plugin/define.js';
import { csharp, type CSharpPluginOptions } from '../../src/plugins.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
/** The generated project targets net10.0, so an older SDK alone (e.g. a CI image's default) cannot build it. */
const hasDotnet10 = (() => {
  const sdks = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8' });
  return sdks.status === 0 && sdks.stdout.split('\n').some((line) => Number(/^(\d+)\./.exec(line)?.[1]) >= 10);
})();

type Case = { name: string; spec: string | OpenAPIDocument; options?: DeepPartial<CSharpPluginOptions>; filters?: FiltersConfig };

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** Schemas named after BCL types the runtime uses, unions referring to each other, and polymorphic variants used directly. */
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
  },
  components: {
    schemas: {
      ...Object.fromEntries(['Task', 'Type', 'Exception', 'Uri', 'Encoding', 'Stream', 'Random', 'Version', 'Action'].map((n) => [n, obj({ a: { type: 'string' } })])),
      U1: { oneOf: [ref('U2'), { type: 'string' }] },
      U2: { oneOf: [ref('U1'), { type: 'integer' }] },
      Shape: { oneOf: [ref('Circle'), ref('Square')], discriminator: { propertyName: 'kind' } },
      Circle: obj({ kind: { const: 'Circle' }, r: { type: 'number' } }, ['kind', 'r']),
      Square: obj({ kind: { const: 'Square' }, s: { type: 'number' } }, ['kind', 's']),
      Mixed: { oneOf: [ref('Shape'), ref('Circle')] },
      Holder: obj({ task: ref('Task'), type: ref('Type'), u: ref('U1'), m: ref('Mixed') }),
    },
  },
};

const cases: Case[] = [
  { name: 'stress (BCL-named schemas, cyclic and mixed unions)', spec: stress },
  { name: 'petstore', spec: 'petstore.yaml' },
  { name: 'edge-cases', spec: 'edge-cases.yaml' },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json' },
  {
    name: 'natsuneko (namespace, clientName, string dates)',
    spec: 'natsuneko.json',
    options: { namespace: 'Natsuneko.Api', clientName: 'NatsunekoClient', typeMappings: { 'string:date-time': 'string' } },
  },
  { name: 'natsuneko (schemas include /^Album/)', spec: 'natsuneko.json', filters: { schemas: { include: ['/^Album/'] } } },
];

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!hasDotnet10).sequential('compile: generated C# SDK builds with dotnet build -warnaserror', () => {
  it.each(cases)('$name', async ({ spec, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-cs-compile-'));
    try {
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: join(dir, 'out'),
          ...(filters && { parser: { filters } }),
          plugins: [csharp({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const { code, output } = await run('dotnet', ['build', '-c', 'Release', '-warnaserror', '-nologo', '-v', 'q'], join(dir, 'out'));
      const problems = output.split('\n').filter((l) => /\b(error|warning) [A-Z]+\d+/.test(l));
      expect({ code, problems: [...new Set(problems)].slice(0, 40) }).toEqual({ code: 0, problems: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
