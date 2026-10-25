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

const specs = fileURLToPath(new URL('../../../../fixtures/specs/', import.meta.url));
const hasDotnet = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;

type Case = { name: string; spec: string; options?: DeepPartial<CSharpPluginOptions>; filters?: FiltersConfig };

const cases: Case[] = [
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

describe.skipIf(!hasDotnet).sequential('compile: generated C# SDK builds with dotnet build -warnaserror', () => {
  it.each(cases)('$name', async ({ spec, options, filters }) => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-cs-compile-'));
    try {
      await generate(
        {
          input: join(specs, spec),
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
