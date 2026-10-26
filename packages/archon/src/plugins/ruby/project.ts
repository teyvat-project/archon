import type { PluginContext } from '../../plugin/types.js';
import { headerComment, rbFile, rbString } from './emit.js';
import type { RubyPluginOptions } from './index.js';

// The only place the minimum Ruby version is written for generated SDKs.
export const RUBY_VERSION = '3.2';

/** A valid gem version: `package.version`, else the spec's version when RubyGems accepts it, else `0.1.0`. */
export function gemVersion(ctx: PluginContext<RubyPluginOptions>): string {
  const pkg = ctx.options.package;
  const candidate = (pkg !== false ? pkg?.version : undefined) ?? ctx.ir.info.version;
  return /^[0-9]+(\.[0-9a-zA-Z]+)*(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(candidate) ? candidate : '0.1.0';
}

/** `lib/<gem>/version.rb`. */
export function renderVersion(ctx: PluginContext<RubyPluginOptions>, moduleName: string): string {
  return rbFile(ctx, moduleName, (w) => {
    w.line('# The version of this SDK.');
    w.line(`VERSION = ${rbString(gemVersion(ctx))}`);
  });
}

/** `<gem>.gemspec`, or nothing when `package` is `false`. */
export function renderGemspec(ctx: PluginContext<RubyPluginOptions>, gemName: string, moduleName: string): { file: string; content: string }[] {
  const pkg = ctx.options.package;
  if (pkg === false) return [];
  const info = ctx.ir.info;
  const lines = ['# frozen_string_literal: true', '', ...headerComment(ctx), '', `require_relative 'lib/${gemName}/version'`, ''];
  lines.push('Gem::Specification.new do |spec|');
  const set = (key: string, value: string) => lines.push(`  spec.${key} = ${value}`);
  set('name', rbString(gemName));
  set('version', `${moduleName}::VERSION`);
  set('summary', rbString(pkg?.summary ?? `A client for ${info.title.replace(/\s+/g, ' ')}`));
  const description = pkg?.description ?? info.description;
  if (description !== undefined && description.trim() !== '') set('description', rbString(description.trim()));
  set('authors', `[${(pkg?.authors ?? [info.title.replace(/\s+/g, ' ')]).map(rbString).join(', ')}]`);
  if (pkg?.license !== undefined) set('license', rbString(pkg.license));
  if (pkg?.homepage !== undefined) set('homepage', rbString(pkg.homepage));
  set('required_ruby_version', rbString(`>= ${pkg?.requiredRubyVersion ?? RUBY_VERSION}`));
  set('files', "Dir['lib/**/*.rb', 'sig/**/*.rbs']");
  set('require_paths', "['lib']");
  lines.push('end');
  return [{ file: `${gemName}.gemspec`, content: `${lines.join('\n')}\n` }];
}
