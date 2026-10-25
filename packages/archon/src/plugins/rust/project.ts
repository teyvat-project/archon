import type { PluginContext } from '../../plugin/types.js';
import { tomlString } from './emit.js';
import type { RustPluginOptions } from './index.js';
import { packageName } from './names.js';

// The only place these versions are written for generated SDKs; a test keeps runtimes/rust and e2e/rust in step.
export const RUST_VERSION = '1.88';
export const REQWEST_VERSION = '0.13.5';
export const SERDE_VERSION = '1.0.229';
export const SERDE_JSON_VERSION = '1.0.154';
export const TOKIO_VERSION = '1.54.1';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `Cargo.toml`, or nothing when `package` is `false`. */
export function renderProject(ctx: PluginContext<RustPluginOptions>): { file: string; content: string }[] {
  const pkg = ctx.options.package;
  if (pkg === false) return [];
  const header = ctx.headerLines('rust').flatMap((l) => l.split('\n')).map((l) => (l === '' ? '#' : `# ${l}`));
  let version = pkg?.version ?? ctx.ir.info.version;
  if (!SEMVER.test(version)) {
    ctx.diagnostics.warn('invalid-version', `"${version}" is not a semantic version; the crate is versioned 0.1.0 (set package.version).`);
    version = '0.1.0';
  }
  const description = pkg?.description ?? ctx.ir.info.description;
  const lines = [
    ...header,
    ...(header.length > 0 ? [''] : []),
    '[package]',
    `name = ${tomlString(packageName(ctx.ir, ctx.options))}`,
    `version = ${tomlString(version)}`,
    'edition = "2021"',
    `rust-version = ${tomlString(RUST_VERSION)}`,
    ...(description ? [`description = ${tomlString(description.trim())}`] : []),
    ...(pkg?.license ? [`license = ${tomlString(pkg.license)}`] : []),
    ...(pkg?.authors ? [`authors = [${pkg.authors.map(tomlString).join(', ')}]`] : []),
    ...(pkg?.repository ? [`repository = ${tomlString(pkg.repository)}`] : []),
    '',
    '[dependencies]',
    `reqwest = { version = "${REQWEST_VERSION}", default-features = false }`,
    `serde = { version = "${SERDE_VERSION}", features = ["derive"] }`,
    `serde_json = { version = "${SERDE_JSON_VERSION}", features = ["preserve_order"] }`,
    `tokio = { version = "${TOKIO_VERSION}", features = ["time", "sync"] }`,
    ...(pkg?.dependencies ?? []),
    '',
    '[features]',
    'default = ["rustls"]',
    '# TLS for https:// base URLs (pick one; build with --no-default-features for native-tls).',
    'rustls = ["reqwest/rustls"]',
    'native-tls = ["reqwest/native-tls"]',
  ];
  return [{ file: 'Cargo.toml', content: `${lines.join('\n')}\n` }];
}
