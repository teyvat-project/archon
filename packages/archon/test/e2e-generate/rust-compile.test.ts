import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from '../../src/generate.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import type { FiltersConfig } from '../../src/passes/filters.js';
import type { DeepPartial } from '../../src/plugin/define.js';
import { rust, type RustPluginOptions } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));

const hasCargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;

type Case = {
  name: string;
  spec: string | OpenAPIDocument;
  options?: DeepPartial<RustPluginOptions>;
  filters?: FiltersConfig;
  /** Build with the default features (rustls) instead of `--no-default-features`. */
  tls?: boolean;
  /** Also compile the doc comments as doctests. */
  doctests?: boolean;
};

const obj = (props: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, required, ...extra });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });

const DOCS = 'Reads */ one /* thing for $name.\n\n```\nlet x: u8 = "not rust";\n```\n\n    indented { code }\n\n```rust\nfn nope( {}\n```';

/**
 * Schemas named after prelude types, crates and the generated modules, Rust keywords as fields and parameters, doc
 * comments that would be doctests, unions referring to each other, and types containing themselves directly.
 */
const stress: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Stress', version: 'not-semver', description: DOCS },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/things': {
      post: {
        operationId: 'postThings',
        tags: ['type'],
        requestBody: { required: true, content: { 'application/json': { schema: ref('Circle') } } },
        responses: { ...ok(ref('Holder')), '4XX': { description: 'client', content: { 'text/plain': { schema: { type: 'string' } } } }, '404': { description: 'nf', content: { 'application/json': { schema: ref('Error') } } } },
      },
    },
    '/things/{class}': {
      get: {
        operationId: 'getThing',
        tags: ['core'],
        description: DOCS,
        parameters: [
          { name: 'class', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'when', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', required: true, schema: { type: 'integer', format: 'int32' } },
          { name: 'self', in: 'header', schema: { type: 'boolean' } },
          { name: 'send', in: 'query', schema: { type: 'string' } },
          { name: 'options', in: 'cookie', schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: { ...ok(ref('Weird')), default: { description: 'any', content: { 'application/json': { schema: ref('Error') } } } },
      },
      delete: { operationId: 'delete', parameters: [{ name: 'class', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'gone' } } },
    },
    '/upload': {
      put: {
        operationId: 'upload',
        tags: ['models'],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: obj({ file: { type: 'string', format: 'binary' }, more: { type: 'array', items: { type: 'string', format: 'binary' } }, meta: ref('Node') }, ['file']),
            },
          },
        },
        responses: { '200': { description: 'bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      },
    },
    '/form': {
      post: {
        operationId: 'form',
        requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', additionalProperties: { type: 'string' } } } } },
        responses: { '201': { description: 'text', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
  },
  components: {
    schemas: {
      ...Object.fromEntries(
        ['String', 'Vec', 'Option', 'Box', 'Result', 'Self', 'Value', 'Unknown', 'Error', 'Debug', 'Core', 'Models', 'Mod', 'Default', 'ApiClient', 'ApiAuth'].map(
          (n) => [n, obj({ a: { type: 'string' } })],
        ),
      ),
      U1: { oneOf: [ref('U2'), { type: 'string' }] },
      U2: { oneOf: [ref('U1'), { type: 'integer' }] },
      Shape: { oneOf: [ref('Circle'), ref('Square')], discriminator: { propertyName: 'kind' } },
      Circle: obj({ kind: { const: 'Circle' }, r: { type: 'number' }, shape: ref('Shape') }, ['kind', 'r']),
      Square: obj({ kind: { type: 'string', enum: ['Square'] }, s: { type: 'number' } }, ['kind', 's']),
      Mixed: { oneOf: [ref('Shape'), ref('Circle'), ref('Unknown'), ref('Error'), { type: 'array', items: ref('String') }, { type: 'null' }] },
      Holder: obj({ u: ref('U1'), m: ref('Mixed'), s: ref('String'), v: ref('Vec'), o: ref('Option'), b: ref('Box'), r: ref('Result'), self: ref('Self') }),
      Weird: obj(
        {
          class: { type: 'string' },
          type: { type: 'string' },
          self: { type: 'string' },
          crate: { type: 'string' },
          'x-foo': { type: 'string' },
          '2fa': { type: 'boolean' },
          foo_bar: { type: 'string' },
          fooBar: { type: 'string' },
          FooBar: { type: 'string' },
          _: { type: 'string' },
          price: { type: 'string', description: DOCS },
          status: { type: 'string', enum: ['value', 'unknown', 'Unknown', '', 'Self', '1st', 'is-known'] },
          level: { type: 'integer', enum: [-1, 0, 1] },
          ratio: { type: 'number', enum: [0.5, 2] },
          tags: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
        },
        ['class', 'type'],
        { description: DOCS },
      ),
      Node: obj({ id: { type: 'string' }, children: { type: 'array', items: ref('Node') }, parent: ref('Node'), next: ref('Node') }, ['id', 'children', 'next']),
      Tree: { oneOf: [ref('Branch'), { type: 'string' }] },
      Branch: obj({ left: ref('Tree'), right: ref('Tree') }, ['left']),
      Old: obj({ a: { type: 'string', deprecated: true } }, [], { deprecated: true }),
      UsesOld: obj({ old: ref('Old') }),
    },
  },
};

const cases: Case[] = [
  { name: 'stress (reserved names, keywords, cyclic types, doctests)', spec: stress, doctests: true },
  { name: 'petstore', spec: 'petstore.yaml' },
  { name: 'edge-cases (default features: rustls)', spec: 'edge-cases.yaml', tls: true },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json' },
  {
    name: 'natsuneko (clientName, i32 integers, renamed package)',
    spec: 'natsuneko.json',
    options: { clientName: 'NatsunekoClient', typeMappings: { integer: 'i32' }, package: { name: 'natsuneko-sdk', version: '1.2.3' } },
  },
  { name: 'natsuneko (schemas include /^Album/)', spec: 'natsuneko.json', filters: { schemas: { include: ['/^Album/'] } } },
];

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!hasCargo)('compile: generated Rust SDK passes cargo clippy with warnings as errors', () => {
  // One target directory for every case, so the dependencies are compiled once.
  let target = '';
  beforeAll(async () => {
    target = await mkdtemp(join(tmpdir(), 'archon-rs-target-'));
  });
  afterAll(async () => {
    if (target !== '') await rm(target, { recursive: true, force: true });
  });

  it.each(cases)('$name', async ({ spec, options, filters, tls, doctests }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-rs-compile-'));
    try {
      const out = join(dir, 'out');
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: out,
          ...(filters && { parser: { filters } }),
          plugins: [rust({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_TERM_COLOR: 'never' };
      const features = tls ? [] : ['--no-default-features'];
      const clippy = await run('cargo', ['clippy', '--all-targets', ...features, '--quiet', '--', '-D', 'warnings'], out, env);
      const problems = clippy.output.split('\n').filter((l) => /^(error|warning)(\[\w+\])?: /.test(l));
      expect({ code: clippy.code, problems: [...new Set(problems)].slice(0, 40) }, clippy.code === 0 ? '' : clippy.output.slice(-6000)).toEqual({
        code: 0,
        problems: [],
      });
      if (doctests) {
        const test = await run('cargo', ['test', '--doc', ...features, '--quiet'], out, env);
        expect(test.code, test.output.slice(-4000)).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 900_000);
});
