#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cac } from 'cac';
import { loadConfigFile, findConfigFile } from './config/load.js';
import { ArchonError } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { generate } from './generate.js';
import { version } from './index.js';

const CONFIG_TEMPLATE = `import { defineConfig } from 'archon';
import { typescript } from 'archon/plugins';

export default defineConfig({
  input: './openapi.yaml',
  output: {
    path: './sdk',
  },
  plugins: [typescript()],
});
`;

function formatDiagnostic(d: Diagnostic): string {
  return `${d.level} ${d.code}: ${d.message}${d.pointer ? ` (${d.pointer})` : ''}`;
}

function print(line: string): void {
  process.stderr.write(`${line}\n`);
}

type GenerateFlags = { config?: string; plugin?: string | string[]; strict?: boolean; verbose?: boolean };

/** CLI を実行して終了コードを返す。`argv` は process.argv と同じ形式（先頭 2 要素は無視される）。 */
export async function runCli(argv: string[]): Promise<number> {
  const cli = cac('archon');
  let exitCode = 0;
  // Diagnostics#error は sink に流してから throw するので、catch 側で二重に出さないよう覚えておく
  let lastPrinted: string | undefined;
  const printDiagnostic = (d: Diagnostic): void => {
    lastPrinted = formatDiagnostic(d);
    print(lastPrinted);
  };

  cli
    .command('generate', 'Generate SDKs from the config file')
    .option('-c, --config <file>', 'Path to the config file (default: archon.config.{ts,mts,mjs,js,json})')
    .option('--plugin <name>', 'Run only the named plugin (and its dependencies); repeatable')
    .option('--strict', 'Fail if any warning is reported')
    .option('--verbose', 'Print info diagnostics')
    .action(async (flags: GenerateFlags) => {
      const cwd = process.cwd();
      const file = findConfigFile({ cwd, ...(flags.config !== undefined && { file: flags.config }) });
      const configs = await loadConfigFile({ cwd, file });
      const plugins = flags.plugin === undefined ? [] : Array.isArray(flags.plugin) ? flags.plugin : [flags.plugin];

      await generate(configs, {
        cwd: dirname(file),
        strict: flags.strict === true,
        verbose: flags.verbose === true,
        ...(plugins.length > 0 && { plugins: plugins.map(String) }),
        logger: (d) => printDiagnostic(d),
      });
    });

  cli.command('init', 'Create an archon.config.ts template in the current directory').action(async () => {
    const target = resolve(process.cwd(), 'archon.config.ts');
    if (existsSync(target)) {
      print(`error init-exists: ${target} already exists; refusing to overwrite it.`);
      exitCode = 1;
      return;
    }
    await writeFile(target, CONFIG_TEMPLATE);
    process.stderr.write(`Created ${target}\n`);
  });

  cli.help();
  cli.version(version);

  try {
    cli.parse(argv, { run: false });
    if (cli.options['help'] || cli.options['version']) return 0;
    if (!cli.matchedCommand) {
      const [name] = cli.args;
      if (name === undefined) {
        cli.outputHelp();
        return 0;
      }
      print(`error unknown-command: Unknown command "${name}". Run "archon --help" for usage.`);
      return 1;
    }
    await cli.runMatchedCommand();
    return exitCode;
  } catch (e) {
    if (e instanceof ArchonError) {
      const line = formatDiagnostic({
        level: 'error',
        code: e.code,
        message: e.message,
        ...(e.pointer !== undefined && { pointer: e.pointer }),
      });
      if (line !== lastPrinted) print(line);
    } else if (e instanceof Error && e.name === 'CACError') {
      print(`error cli: ${e.message}`);
    } else {
      print(e instanceof Error ? (e.stack ?? String(e)) : String(e));
    }
    return 1;
  }
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exit(await runCli(process.argv));
}
