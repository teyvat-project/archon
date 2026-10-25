import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { OutputConfig, PostProcessCommand } from '../config/types.js';
import type { Diagnostics } from '../diagnostics.js';
import type { EmittedFile } from '../plugin/types.js';

/**
 * 生成物をディスクに書き出し、`postProcess` を実行する。
 *
 * - `opts.root`: `output.path` が相対パスの場合の基準、および postProcess の cwd。
 * - `opts.outputDirs`: 今回 emit したプラグインの出力先（`output.path` 相対）。`output.clean` が true のとき、
 *   ここに挙げたディレクトリだけを削除してから書き込む。`'.'` は `output.path` 全体を指す。
 *   `output.path` の外は決して削除しない。
 */
export async function writeOutput(
  files: EmittedFile[],
  output: Required<OutputConfig>,
  opts: { root: string; diagnostics: Diagnostics; outputDirs: string[] },
): Promise<void> {
  const { diagnostics } = opts;
  const outDir = resolve(opts.root, output.path);

  // 何かを削除する前に、すべてのパスを検証する
  const cleanTargets = output.clean
    ? [...new Set(opts.outputDirs)].map((dir) => resolveInside(outDir, dir, diagnostics, `output directory "${dir}"`))
    : [];
  const writes = files.map((file) => ({
    target: resolveInside(outDir, file.path, diagnostics, `output file "${file.path}"`),
    content: file.content,
  }));
  if (cleanTargets.includes(outDir) && contains(outDir, resolve(opts.root))) {
    diagnostics.error(
      'unsafe-clean',
      `Refusing to clean "${outDir}": it contains the project root. Use a dedicated output directory.`,
    );
  }

  for (const target of cleanTargets) await rm(target, { recursive: true, force: true });

  await mkdir(outDir, { recursive: true });
  for (const { target, content } of writes) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  for (const command of output.postProcess) {
    await runPostProcess(command, outDir, opts.root, diagnostics);
  }
}

/** `outDir` 配下（`outDir` 自身を含む）に解決されることを検証して絶対パスを返す。 */
function resolveInside(outDir: string, path: string, diagnostics: Diagnostics, what: string): string {
  const target = resolve(outDir, path);
  if (isAbsolute(path) || !contains(outDir, target)) {
    return diagnostics.error('invalid-output-path', `The ${what} is outside the output path "${outDir}".`);
  }
  return target;
}

/** `parent` が `child` と同じか、その祖先であれば true。 */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function runPostProcess(
  command: PostProcessCommand,
  outDir: string,
  cwd: string,
  diagnostics: Diagnostics,
): Promise<void> {
  const args = command.args.map((a) => a.replaceAll('{{path}}', outDir));
  const label = [command.command, ...args].join(' ');
  return new Promise((done) => {
    let stderr = '';
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      const detail = stderr.trim();
      diagnostics.warn('post-process-failed', `postProcess "${label}" ${reason}${detail ? `: ${detail}` : ''}`);
      done();
    };
    const child = spawn(command.command, args, { cwd, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.once('error', (err) => fail(`could not be started (${err.message})`));
    child.once('close', (code, signal) => {
      if (code === 0) {
        settled = true;
        done();
      } else fail(signal ? `was terminated by ${signal}` : `exited with code ${code}`);
    });
  });
}
