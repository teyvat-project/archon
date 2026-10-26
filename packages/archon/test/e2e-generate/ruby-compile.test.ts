import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../../src/generate.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import type { FiltersConfig } from '../../src/passes/filters.js';
import type { DeepPartial } from '../../src/plugin/define.js';
import { ruby, type RubyPluginOptions } from '../../src/plugins.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));

const hasRuby = spawnSync('ruby', ['-e', 'exit(RUBY_VERSION >= "3.2" ? 0 : 1)'], { encoding: 'utf8' }).status === 0;
const hasRbs = spawnSync('rbs', ['--version'], { encoding: 'utf8' }).status === 0;

type Case = { name: string; spec: string | OpenAPIDocument; gem: string; module: string; options?: DeepPartial<RubyPluginOptions>; filters?: FiltersConfig };

const obj = (props: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, required, ...extra });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Schemas named after Ruby's own classes and the SDK's constants, members and arguments named after keywords,
 * Object methods and the generated method's locals, enum values that are not constant names, doc comments with
 * Ruby syntax in them, unions referring to each other, and self-referencing / mutually referencing models.
 */
const stress: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Stress', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/things': {
      post: {
        operationId: 'initialize',
        tags: ['core'],
        description: 'Posts things.\n\n=begin\n#{oops}\n=end\n  indented',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Circle') } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Holder') } } } },
      },
    },
    '/things/{class}': {
      get: {
        operationId: 'send',
        tags: ['use'],
        parameters: [
          { name: 'class', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'body', in: 'query', schema: { type: 'string' } },
          { name: 'values', in: 'query', schema: { type: 'string' } },
          { name: 'request_options', in: 'header', schema: { type: 'string' } },
          { name: 'if', in: 'cookie', schema: { type: 'string', format: 'date-time' } },
          { name: 'filter', in: 'query', style: 'deepObject', schema: ref('Weird') },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Weird') } } } },
      },
    },
    '/files': {
      put: {
        operationId: 'putFiles',
        tags: ['class'],
        requestBody: { content: { 'multipart/form-data': { schema: obj({ doc: { type: 'string', format: 'binary' }, n: { type: 'integer' } }) } } },
        responses: { '204': { description: 'none' } },
      },
      patch: {
        operationId: 'hash',
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
        responses: { '200': { description: 'ok', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      },
    },
  },
  components: {
    schemas: {
      ...Object.fromEntries(
        ['Client', 'Core', 'Auth', 'String', 'Data', 'Time', 'Date', 'File', 'Hash', 'Integer', 'Struct', 'ApiError', 'Error', 'Unknown', 'CoreService', 'Version'].map((n) => [
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
      Holder: obj({ client: ref('Client'), u: ref('U1'), m: ref('Mixed'), s: ref('String'), e: ref('Error'), maybe: { oneOf: [ref('Shape'), { type: 'null' }] } }),
      Weird: obj(
        {
          class: { type: 'string' },
          method: { type: 'string' },
          end: { type: 'string' },
          hash: { type: 'integer' },
          to_h: { type: 'string' },
          'x-foo': { type: 'string' },
          '2fa': { type: 'boolean' },
          foo_bar: { type: 'string' },
          fooBar: { type: 'string' },
          'quote"d': { type: 'string' },
          '#{x}': { type: 'string' },
          '日本': { type: 'string' },
          price: { type: 'string', description: 'Costs #{price} $5\n\n=begin\n  - listed' },
          status: { type: 'string', enum: ['value', 'is-known', '', 'VALUES', 'Value'] },
          level: { type: 'integer', enum: [-1, 0, 1] },
          ratio: { type: 'number', enum: [0.5, 1.5] },
          when: { type: 'string', format: 'date' },
          blob: { type: 'string', format: 'byte' },
        },
        ['class', '2fa'],
        { description: 'A weird schema.\n\n=begin\n\n\nend' },
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
  { name: 'stress (reserved names, cycles, doc comments, unions)', spec: stress, gem: 'stress', module: 'Stress' },
  { name: 'petstore', spec: 'petstore.yaml', gem: 'swagger_petstore', module: 'SwaggerPetstore' },
  { name: 'edge-cases', spec: 'edge-cases.yaml', gem: 'archon_edge_cases', module: 'ArchonEdgeCases' },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json', gem: 'natsuneko_laboratory_api', module: 'NatsunekoLaboratoryApi' },
  {
    name: 'natsuneko (gemName, nested moduleName, date-time as string)',
    spec: 'natsuneko.json',
    gem: 'natsuneko',
    module: 'Natsuneko::Api',
    options: { gemName: 'natsuneko', moduleName: 'Natsuneko::Api', typeMappings: { 'string:date-time': 'string' } },
  },
  { name: 'natsuneko (schemas include /^Album/)', spec: 'natsuneko.json', gem: 'natsuneko_laboratory_api', module: 'NatsunekoLaboratoryApi', filters: { schemas: { include: ['/^Album/'] } } },
];

/** Loads the SDK and resolves every lazy model reference (a NameError would otherwise only surface on use). */
const LOAD_CHECK = `
mod = Object.const_get(ARGV.fetch(0))
types = mod::Core::Types
check = lambda do |t|
  case t
  when types::Ref then t.target
  when types::ArrayOf then check.(t.item)
  when types::MapOf then check.(t.value)
  when types::Nullable then check.(t.instance_variable_get(:@type))
  end
end
mod.constants.map { |c| mod.const_get(c) }.each do |value|
  if value.is_a?(Class) && value.include?(mod::Core::Model)
    value.json_fields.each { |f| check.(f.type) }
  elsif value.is_a?(Module) && value.singleton_class.include?(mod::Core::Union)
    (value.instance_variable_get(:@variants) || []).each { |t| check.(t) }
    value.instance_variable_get(:@discriminator)&.last&.each_value { |t| check.(t) }
  end
end
ObjectSpace.each_object(mod::Core::Operation) do |op|
  check.(op.result)
  op.errors.each_value { |t| check.(t) }
end
mod::Client.new(base_url: 'https://api.test')
puts 'loaded'
`;

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function rubyFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && /\.(rb|gemspec)$/.test(e.name)).map((e) => relative(dir, join(e.parentPath, e.name)));
}

describe.skipIf(!hasRuby)('compile: generated Ruby SDK passes ruby -wc, loads without warnings and validates with rbs', () => {
  it.each(cases)('$name', async ({ spec, gem, module, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-rb-compile-'));
    try {
      const out = join(dir, 'out');
      await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: out,
          ...(filters && { parser: { filters } }),
          plugins: [ruby({ output: '.', ...options })],
        },
        { cwd: dir },
      );
      const files = await rubyFiles(out);
      // Compiles every file (`ruby -c a.rb b.rb` would only check the first) with parse warnings enabled.
      const syntax = await run('ruby', ['-w', '-e', 'ARGV.each { |f| RubyVM::InstructionSequence.compile_file(f) }', ...files], out);
      expect(files.length).toBeGreaterThan(10);
      expect({ code: syntax.code, warnings: syntax.stderr.split('\n').filter((l) => l !== '').slice(0, 20) }).toEqual({ code: 0, warnings: [] });

      await writeFile(join(dir, 'load_check.rb'), LOAD_CHECK);
      const load = await run('ruby', ['-w', '-Ilib', '-r', gem, join(dir, 'load_check.rb'), module], out);
      expect({ code: load.code, stdout: load.stdout.trim(), stderr: load.stderr.split('\n').filter((l) => l !== '').slice(0, 20) }).toEqual({
        code: 0,
        stdout: 'loaded',
        stderr: [],
      });

      if (hasRbs) {
        const libs = ['json', 'net-http', 'time', 'date', 'uri', 'securerandom'].flatMap((l) => ['-r', l]);
        const rbs = await run('rbs', [...libs, '-I', 'sig', 'validate'], out);
        expect({ code: rbs.code, output: `${rbs.stdout}${rbs.stderr}`.split('\n').filter((l) => /error|Error/.test(l)).slice(0, 20) }).toEqual({ code: 0, output: [] });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
