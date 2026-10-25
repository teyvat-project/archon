import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { generate } from '../../src/generate.js';
import { typescript } from '../../src/plugins.js';
import type { TypeScriptPluginOptions } from '../../src/plugins.js';
import type { DeepPartial } from '../../src/plugin/define.js';

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
const tsc = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url));

type Case = { name: string; spec: string; options: DeepPartial<TypeScriptPluginOptions> };

const cases: Case[] = [
  { name: 'petstore', spec: 'petstore.yaml', options: {} },
  { name: 'edge-cases', spec: 'edge-cases.yaml', options: {} },
  { name: 'natsuneko (defaults)', spec: 'natsuneko.json', options: {} },
  { name: 'natsuneko (enum + class)', spec: 'natsuneko.json', options: { enums: 'enum', sdk: { style: 'class' } } },
  { name: 'natsuneko (Date + .ts)', spec: 'natsuneko.json', options: { dates: 'Date', importExtension: '.ts' } },
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
  it.for(cases)('$name', { timeout: 120_000 }, async ({ spec, options }, { expect }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-compile-'));
    try {
      const out = join(dir, 'out');
      await generate({ input: join(specs, spec), output: out, plugins: [typescript({ ...options, output: '.' })] }, { cwd: dir });

      const result = await run(tsc, ['-p', out, '--noEmit']);
      expect(result.output).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
