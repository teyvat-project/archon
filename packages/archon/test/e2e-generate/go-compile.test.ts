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
import { go, type GoPluginOptions } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

type Case = { name: string; spec: string | OpenAPIDocument; options?: DeepPartial<GoPluginOptions>; filters?: FiltersConfig };

const obj = (props: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, required, ...extra });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Schemas named after the client's own names and Go file suffixes, struct fields clashing with methods or each
 * other, json tag names Go cannot express, doc comments gofmt would rewrite, unions referring to each other, value
 * fields forming a cycle, and a self-referencing tree.
 */
const stress: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Stress', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/things': {
      post: {
        operationId: 'postThings',
        tags: ['core'],
        description: 'Posts things.\n\n- one\n    indented\n\n\n# Heading\n1. first',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Circle') } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Holder') } } } },
      },
    },
    '/things/{type}': {
      get: {
        operationId: 'getThing',
        tags: ['use'],
        parameters: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'func', in: 'query', schema: { type: 'string' } },
          { name: 'Func', in: 'header', schema: { type: 'string' } },
          { name: 'ctx', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Weird') } } } },
      },
    },
    '/files': {
      put: {
        operationId: 'putFiles',
        requestBody: { content: { 'multipart/form-data': { schema: obj({ doc: { type: 'string', format: 'binary' }, n: { type: 'integer' } }) } } },
        responses: { '204': { description: 'none' } },
      },
      patch: {
        operationId: 'patchText',
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
        responses: { '200': { description: 'ok', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      },
    },
  },
  components: {
    schemas: {
      ...Object.fromEntries(
        ['Client', 'ClientOptions', 'Auth', 'NewClient', 'String', 'Error', 'Time', 'File', 'Test', 'Windows', 'Thing_amd64', 'CoreService'].map((n) => [
          n,
          obj({ a: { type: 'string' } }),
        ]),
      ),
      '1Thing': obj({ a: { type: 'string' } }),
      U1: { oneOf: [ref('U2'), { type: 'string' }] },
      U2: { oneOf: [ref('U1'), { type: 'integer' }] },
      Shape: { oneOf: [ref('Circle'), ref('Square')], discriminator: { propertyName: 'kind' } },
      Circle: obj({ kind: { const: 'Circle' }, r: { type: 'number' } }, ['kind', 'r']),
      Square: obj({ kind: { type: 'string', enum: ['Square'] }, s: { type: 'number' } }, ['kind', 's']),
      Mixed: {
        oneOf: [ref('Shape'), ref('Circle'), ref('Time'), { type: 'array', items: ref('String') }, { type: 'string', format: 'date-time' }, { type: 'boolean' }],
      },
      Holder: obj({ client: ref('Client'), u: ref('U1'), m: ref('Mixed'), s: ref('String'), e: ref('Error') }),
      Weird: obj(
        {
          type: { type: 'string' },
          'x-foo': { type: 'string' },
          '2fa': { type: 'boolean' },
          foo_bar: { type: 'string' },
          fooBar: { type: 'string' },
          FooBar: { type: 'string' },
          marshalJSON: { type: 'string' },
          'quote"d': { type: 'string' },
          'a,b': { type: 'string' },
          price: { type: 'string', description: 'Costs */ $5\n\n- listed\n  indented' },
          status: { type: 'string', enum: ['value', 'is-known', '', 'IsKnown'] },
          level: { type: 'integer', enum: [-1, 0, 1] },
          ratio: { type: 'number', enum: [0.5, 1.5] },
          when: { type: 'string', format: 'date' },
          blob: { type: 'string', format: 'byte' },
        },
        ['type', '2fa'],
        { description: 'A */ weird schema.\n\n  - indented list\n\n\nend' },
      ),
      Node: obj({ id: { type: 'string' }, children: { type: 'array', items: ref('Node') }, parent: ref('Node') }, ['id', 'children']),
      A: obj({ b: ref('B') }, ['b']),
      B: obj({ a: ref('A'), self: ref('B') }, ['a']),
      Old: obj({ a: { type: 'string', deprecated: true } }, [], { deprecated: true }),
      UsesOld: obj({ old: ref('Old') }),
    },
  },
};

const cases: Case[] = [
  { name: 'stress (reserved names, cycles, doc comments, unions)', spec: stress },
  { name: 'petstore', spec: 'petstore.yaml' },
  { name: 'edge-cases', spec: 'edge-cases.yaml' },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json' },
  {
    name: 'natsuneko (module, packageName, date-time as string)',
    spec: 'natsuneko.json',
    options: { module: 'github.com/natsuneko/api', packageName: 'natsuneko', typeMappings: { 'string:date-time': 'string' } },
  },
  { name: 'natsuneko (schemas include /^Album/)', spec: 'natsuneko.json', filters: { schemas: { include: ['/^Album/'] } } },
];

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, GOFLAGS: '-mod=mod' } });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!hasGo)('compile: generated Go SDK passes go vet and is gofmt-formatted', () => {
  it.each(cases)('$name', async ({ spec, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-go-compile-'));
    try {
      const out = join(dir, 'out');
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: out,
          ...(filters && { parser: { filters } }),
          plugins: [go({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const vet = await run('go', ['vet', './...'], out);
      expect({ code: vet.code, output: vet.output.split('\n').slice(0, 40) }).toEqual({ code: 0, output: [''] });
      const fmt = await run('gofmt', ['-l', '.'], out);
      expect({ code: fmt.code, unformatted: fmt.output.split('\n').filter((l) => l !== '') }).toEqual({ code: 0, unformatted: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
