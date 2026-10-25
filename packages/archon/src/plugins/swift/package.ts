import type { PluginContext } from '../../plugin/types.js';
import { literal } from './emit.js';
import type { SwiftPluginOptions } from './index.js';

/** `Package.swift`, or `undefined` when `package` is `false`. The tools-version comment must stay the first line. */
export function renderPackage(ctx: PluginContext<SwiftPluginOptions>, module: string, core: string): string | undefined {
  const pkg = ctx.options.package;
  if (pkg === false) return undefined;
  const name = pkg?.name ?? module;
  const header = ctx.writer().comment(ctx.headerLines('swift'), 'line').toString();
  const lines = [
    '// swift-tools-version:6.0',
    ...(header === '' ? [] : [header.trimEnd()]),
    'import PackageDescription',
    '',
    'let package = Package(',
    `    name: ${literal(name)},`,
    '    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8), .visionOS(.v1)],',
    '    products: [',
    `        .library(name: ${literal(module)}, targets: [${literal(module)}]),`,
    '    ],',
    '    targets: [',
    `        .target(name: ${literal(core)}),`,
    `        .target(name: ${literal(module)}, dependencies: [${literal(core)}]),`,
    '    ]',
    ')',
  ];
  return `${lines.join('\n')}\n`;
}
