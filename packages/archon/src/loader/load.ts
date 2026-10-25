import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { parse as parseYaml } from 'yaml';
import type { Diagnostics } from '../diagnostics.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenAPIDocument = Record<string, any> & { openapi: string };

export type InputConfig = string | { path: string; headers?: Record<string, string> } | OpenAPIDocument;

const URL_PATTERN = /^https?:\/\//i;
const SUPPORTED_VERSION = /^3\.[01](\.\d+)?(-.+)?$/;

export async function loadInput(
  input: InputConfig,
  opts: { cwd: string; diagnostics: Diagnostics },
): Promise<OpenAPIDocument> {
  const { cwd, diagnostics } = opts;
  let doc: Record<string, unknown>;
  let base: string | undefined;

  const pathInput: { path: string; headers?: Record<string, string> } | undefined =
    typeof input === 'string' ? { path: input } : isPathInput(input) ? input : undefined;
  if (pathInput) {
    const { path, headers } = pathInput;
    if (URL_PATTERN.test(path)) {
      doc = parseText(await fetchText(path, headers, diagnostics), path, diagnostics);
      base = path;
    } else {
      const file = resolve(cwd, path);
      doc = parseText(await readLocal(file, path, diagnostics), file, diagnostics);
      base = file;
    }
  } else {
    doc = structuredClone(input as OpenAPIDocument);
  }

  if (base !== undefined || hasExternalRef(doc)) {
    doc = await bundleRefs(doc, base ?? resolve(cwd, '__inline__.yaml'), diagnostics);
  }

  assertSupportedVersion(doc, diagnostics);
  return doc as OpenAPIDocument;
}

function isPathInput(input: Exclude<InputConfig, string>): input is { path: string; headers?: Record<string, string> } {
  return typeof input['path'] === 'string' && !('openapi' in input) && !('swagger' in input);
}

async function fetchText(
  url: string,
  headers: Record<string, string> | undefined,
  diagnostics: Diagnostics,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, headers ? { headers } : undefined);
  } catch (e) {
    return diagnostics.error('input-fetch-failed', `Failed to fetch ${url}: ${errorMessage(e)}`);
  }
  if (!res.ok) {
    return diagnostics.error('input-fetch-failed', `Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function readLocal(file: string, original: string, diagnostics: Diagnostics): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return diagnostics.error('input-not-found', `Input file not found: ${original} (resolved to ${file})`);
    }
    return diagnostics.error('input-read-failed', `Failed to read ${file}: ${errorMessage(e)}`);
  }
}

function parseText(raw: string, source: string, diagnostics: Diagnostics): Record<string, unknown> {
  // JSON.parse rejects a leading byte order mark; editors on Windows commonly write one.
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const ext = extname(source.split(/[?#]/)[0] ?? '').toLowerCase();
  let parsed: unknown;
  try {
    if (ext === '.json') parsed = JSON.parse(text);
    else if (ext === '.yaml' || ext === '.yml') parsed = parseYaml(text);
    else parsed = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    return diagnostics.error('input-parse-failed', `Failed to parse ${source}: ${errorMessage(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return diagnostics.error('input-parse-failed', `${source} does not contain an OpenAPI document object`);
  }
  return parsed as Record<string, unknown>;
}

async function bundleRefs(
  doc: Record<string, unknown>,
  base: string,
  diagnostics: Diagnostics,
): Promise<Record<string, unknown>> {
  try {
    // ref-parser は渡したオブジェクトを書き換えるため clone を渡す。
    return await $RefParser.bundle(base, structuredClone(doc), {});
  } catch (e) {
    return diagnostics.error('ref-resolve-failed', `Failed to resolve $ref: ${errorMessage(e)}`);
  }
}

function hasExternalRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasExternalRef);
  if (node === null || typeof node !== 'object') return false;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) return true;
    if (hasExternalRef(v)) return true;
  }
  return false;
}

function assertSupportedVersion(doc: Record<string, unknown>, diagnostics: Diagnostics): void {
  const version = doc['openapi'];
  if (typeof version === 'string' && SUPPORTED_VERSION.test(version)) return;
  const found =
    typeof version === 'string'
      ? `openapi: ${version}`
      : typeof doc['swagger'] === 'string'
        ? `swagger: ${doc['swagger']}`
        : 'no openapi field';
  diagnostics.error('unsupported-version', `Unsupported OpenAPI version (${found}). Only 3.0.x and 3.1.x are supported.`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
