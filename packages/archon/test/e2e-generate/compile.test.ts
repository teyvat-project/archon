import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { generate } from '../../src/generate.js';
import { typescript } from '../../src/plugins.js';
import type { TypeScriptPluginOptions } from '../../src/plugins.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import type { FiltersConfig } from '../../src/passes/filters.js';
import type { DeepPartial } from '../../src/plugin/define.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
const tsc = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url));

type Case = {
  name: string;
  /** fixtures/specs のファイル名、または OpenAPI ドキュメントそのもの。 */
  spec: string | OpenAPIDocument;
  options: DeepPartial<TypeScriptPluginOptions>;
  filters?: FiltersConfig;
  /** 生成物と一緒に型検査する追加ファイル（`check.ts`）。 */
  check?: string;
  /** 出ていなければならない warn の code。 */
  warnings?: string[];
};

const ok = { description: 'ok' };
const jsonOf = (schema: unknown) => ({ 'application/json': { schema } });

/** 4xx の body に（inline と、2xx と共有する named schema 経由の）date-time を持つ spec。 */
const errorDates: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Error Dates', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': { ...ok, content: jsonOf({ $ref: '#/components/schemas/Problem' }) },
          '400': {
            ...ok,
            content: jsonOf({ type: 'object', required: ['timestamp'], properties: { timestamp: { type: 'string', format: 'date-time' } } }),
          },
          '404': { ...ok, content: jsonOf({ $ref: '#/components/schemas/Problem' }) },
        },
      },
    },
  },
  components: {
    schemas: {
      Problem: {
        type: 'object',
        required: ['timestamp', 'tags'],
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' } },
          blob: { type: 'string', format: 'binary' },
        },
      },
    },
  },
};

const errorDatesCheck = `import type { GetThingErrors, GetThingResponses } from './index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(): T => true as T;

assert<Equal<GetThingResponses[200]['timestamp'], Date>>();
assert<Equal<GetThingErrors[400]['timestamp'], string>>();
assert<Equal<GetThingErrors[404]['timestamp'], string>>();
assert<Equal<GetThingErrors[404]['tags'], string[]>>();
assert<Equal<GetThingErrors[404]['blob'], Blob | undefined>>();
`;

/** deprecated な schema が deprecated でない操作から参照されたままの spec。 */
const deprecatedRef: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Deprecated Ref', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/a': { get: { operationId: 'getA', responses: { '200': { ...ok, content: jsonOf({ $ref: '#/components/schemas/Old' }) } } } },
  },
  components: { schemas: { Old: { type: 'object', deprecated: true, properties: { x: { type: 'string' } } } } },
};

const cases: Case[] = [
  { name: 'petstore', spec: 'petstore.yaml', options: {} },
  { name: 'edge-cases', spec: 'edge-cases.yaml', options: {} },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json', options: {} },
  { name: 'natsuneko (enum + class)', spec: 'natsuneko.json', options: { enums: 'enum', sdk: { style: 'class' } } },
  { name: 'natsuneko (Date + .ts)', spec: 'natsuneko.json', options: { dates: 'Date', importExtension: '.ts' } },
  {
    name: 'natsuneko (schemas include /^Album/)',
    spec: 'natsuneko.json',
    options: {},
    filters: { schemas: { include: ['/^Album/'] } },
    warnings: ['filter-dangling-ref'],
  },
  {
    name: 'deprecated:false with a still-referenced deprecated schema',
    spec: deprecatedRef,
    options: {},
    filters: { deprecated: false },
    warnings: ['filter-dangling-ref'],
  },
  { name: 'error bodies with dates (Date)', spec: errorDates, options: { dates: 'Date' }, check: errorDatesCheck },
];

function run(command: string, args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

describe.concurrent('compile: generated SDK type-checks with its own tsconfig', () => {
  it.for(cases)('$name', { timeout: 120_000 }, async ({ spec, options, filters, check, warnings }, { expect }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-compile-'));
    try {
      const out = join(dir, 'out');
      const generated = await generate(
        {
          input: typeof spec === 'string' ? join(specs, spec) : spec,
          output: out,
          ...(filters && { parser: { filters } }),
          plugins: [typescript({ ...options, output: '.' })],
        },
        { cwd: dir },
      );
      const codes = new Set(generated.jobs.flatMap((j) => j.diagnostics.filter((d) => d.level === 'warn').map((d) => d.code)));
      for (const code of warnings ?? []) expect(codes).toContain(code);
      if (check !== undefined) await writeFile(join(out, 'check.ts'), check);

      const result = await run(tsc, ['-p', out, '--noEmit']);
      expect(result.output).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
