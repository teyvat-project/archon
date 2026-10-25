import type { PluginContext } from '../../plugin/types.js';
import { headerComment } from './emit.js';
import type { GoPluginOptions } from './index.js';

// The only place the minimum Go version is written for generated SDKs; a test keeps runtimes/go and e2e/go in step.
export const GO_VERSION = '1.22';

/** `go.mod`, or nothing when `package` is `false`. */
export function renderProject(ctx: PluginContext<GoPluginOptions>, module: string): { file: string; content: string }[] {
  const pkg = ctx.options.package;
  if (pkg === false) return [];
  const lines = [...headerComment(ctx), '', `module ${module}`, '', `go ${pkg?.goVersion ?? GO_VERSION}`];
  const dependencies = pkg?.dependencies ?? [];
  if (dependencies.length > 0) lines.push('', 'require (', ...dependencies.map((d) => `\t${d}`), ')');
  return [{ file: 'go.mod', content: `${lines.join('\n')}\n` }];
}
