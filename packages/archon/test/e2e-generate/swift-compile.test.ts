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
import { swift, type SwiftPluginOptions } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
/** The generated package needs Swift 6 (tools-version 6.0). */
const hasSwift6 = (() => {
  const version = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  return version.status === 0 && Number(/Swift version (\d+)/.exec(`${version.stdout}${version.stderr}`)?.[1]) >= 6;
})();

type Case = { name: string; spec: string | OpenAPIDocument; options?: DeepPartial<SwiftPluginOptions>; filters?: FiltersConfig };

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonOf = (schema: unknown) => ({ 'application/json': { schema } });

/**
 * Schemas named after standard library / Foundation / runtime types, value cycles through structs and unions, unions
 * containing each other, and identifiers Swift reserves.
 */
const stress: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Stress', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/things/{id}': {
      post: {
        operationId: 'postThings',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'query', schema: { type: 'string' } },
          { name: 'options', in: 'query', schema: { type: 'string' } },
          { name: 'class', in: 'header', schema: { type: 'string' } },
          { name: 'when', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        requestBody: { required: true, content: jsonOf(ref('Circle')) },
        responses: {
          '200': { description: 'ok', content: jsonOf(ref('Holder')) },
          '404': { description: 'nope', content: jsonOf(ref('Error')) },
        },
      },
    },
    '/form': {
      put: {
        operationId: 'putForm',
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'string' } } } },
        responses: { '200': { description: 'ok', content: jsonOf({ type: ['object', 'null'], properties: { a: { type: 'string' } } }) } },
      },
    },
    '/parts': {
      post: {
        operationId: 'postParts',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'array', items: { type: 'string' } } } } },
        responses: { '204': { description: 'none' } },
      },
    },
  },
  components: {
    schemas: {
      ...Object.fromEntries(
        ['Error', 'Date', 'Data', 'String', 'Int', 'Bool', 'Type', 'Self', 'Task', 'Result', 'URL', 'UUID', 'Codable', 'Decoder', 'ApiRequest', 'JSONValue', 'Swift'].map((n) => [
          n,
          obj({ a: { type: 'string' }, at: { type: 'string', format: 'date-time' }, n: { type: 'integer' }, b: { type: 'boolean' } }),
        ]),
      ),
      U1: { oneOf: [ref('U2'), { type: 'string' }] },
      U2: { oneOf: [ref('U1'), { type: 'integer' }] },
      Shape: { oneOf: [ref('Circle'), ref('Square')], discriminator: { propertyName: 'kind' } },
      Circle: obj({ kind: { const: 'Circle' }, r: { type: 'number' } }, ['kind', 'r']),
      Square: obj({ kind: { const: 'Square' }, s: { type: 'number' } }, ['kind', 's']),
      Mixed: { oneOf: [ref('Shape'), ref('Circle'), { type: 'array', items: ref('Mixed') }] },
      Node: obj({ parent: ref('Node'), children: { type: 'array', items: ref('Node') }, map: { type: 'object', additionalProperties: ref('Node') } }),
      A: obj({ b: ref('B') }, ['b']),
      B: obj({ a: ref('A'), tree: ref('Tree') }),
      Tree: { oneOf: [ref('Leaf'), ref('Branch')] },
      Leaf: obj({ value: { type: 'integer' } }, ['value']),
      Branch: obj({ first: ref('Tree'), holder: ref('B') }),
      Keywords: obj({
        class: { type: 'string' },
        default: { type: 'string' },
        self: { type: 'string' },
        Type: { type: 'string' },
        hashValue: { type: 'integer' },
        'x-foo': { type: 'string' },
        '2fa': { type: 'string' },
        mode: { type: 'string', enum: ['', 'default', 'unknown', '1', 'self', 'init', 'rawValue'] },
      }),
      Bag: { ...obj({ a: { type: 'string' } }), additionalProperties: { type: 'integer' } },
      Holder: obj({
        error: ref('Error'),
        date: ref('Date'),
        type: ref('Type'),
        u: ref('U1'),
        m: ref('Mixed'),
        node: ref('Node'),
        a: ref('A'),
        k: ref('Keywords'),
        bag: ref('Bag'),
        at: { type: 'string', format: 'date-time' },
      }),
    },
  },
};

const cases: Case[] = [
  { name: 'stress (shadowed standard names, value cycles, cyclic unions, keywords)', spec: stress },
  { name: 'petstore', spec: 'petstore.yaml' },
  { name: 'edge-cases', spec: 'edge-cases.yaml' },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json' },
  {
    name: 'natsuneko (moduleName, clientName, string dates)',
    spec: 'natsuneko.json',
    options: { moduleName: 'NatsunekoApi', clientName: 'NatsunekoClient', typeMappings: { 'string:date-time': 'String' } },
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

describe.skipIf(!hasSwift6)('compile: generated Swift SDK builds with swift build -warnings-as-errors', () => {
  it.each(cases)('$name', async ({ spec, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-swift-compile-'));
    try {
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: join(dir, 'out'),
          ...(filters && { parser: { filters } }),
          plugins: [swift({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const { code, output } = await run('swift', ['build', '-Xswiftc', '-warnings-as-errors'], join(dir, 'out'));
      // eslint-disable-next-line no-control-regex
      const problems = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /^\/.*: (error|warning): /.test(l));
      expect({ code, problems: [...new Set(problems)].slice(0, 40) }).toEqual({ code: 0, problems: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
