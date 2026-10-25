import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchonError, Diagnostics } from '../../src/diagnostics.js';
import { loadInput, type OpenAPIDocument } from '../../src/loader/load.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/loader');

describe('loadInput', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it('loads YAML file and bundles external $ref', async () => {
    const doc = await loadInput('root.yaml', { cwd: fixtures, diagnostics: new Diagnostics() });
    // ref-parser は最初の出現箇所に実体を取り込み、以降を内部 $ref にする。
    const refs: string[] = [];
    JSON.stringify(doc, (k, v) => {
      if (k === '$ref') refs.push(v as string);
      return v;
    });
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.startsWith('#/'))).toBe(true);
    expect(JSON.stringify(doc)).toContain('"required":["name"]');
    const pets = doc.paths['/pets'].get.responses['200'].content['application/json'].schema;
    const byId = doc.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema;
    expect([pets.$ref, byId.$ref].filter(Boolean)).toHaveLength(1);
    expect(doc.components.schemas.Local.properties.pet.$ref).toBe('#/components/schemas/Other');
  });

  it('strips a leading UTF-8 BOM from JSON and YAML files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-bom-'));
    try {
      const spec = { openapi: '3.1.0', info: { title: 'bom', version: '1' }, paths: {} };
      await writeFile(join(dir, 'spec.json'), `\uFEFF${JSON.stringify(spec)}`);
      await writeFile(join(dir, 'spec.yaml'), '\uFEFFopenapi: 3.1.0\ninfo:\n  title: bom\n  version: "1"\npaths: {}\n');
      await writeFile(join(dir, 'spec.txt'), `\uFEFF${JSON.stringify(spec)}`);
      for (const name of ['spec.json', 'spec.yaml', 'spec.txt']) {
        const doc = await loadInput(name, { cwd: dir, diagnostics: new Diagnostics() });
        expect(doc.info.title).toBe('bom');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads JSON object input as-is', async () => {
    const input: OpenAPIDocument = { openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: {} };
    const doc = await loadInput(input, { cwd: fixtures, diagnostics: new Diagnostics() });
    expect(doc).toEqual(input);
    expect(doc).not.toBe(input);
    input.info.title = 'changed';
    expect(doc.info.title).toBe('x');
  });

  it('fetches URL input with headers', async () => {
    const spec = { openapi: '3.0.3', info: { title: 'remote', version: '1' }, paths: {} };
    server = createServer((req, res) => {
      if (req.headers['x-token'] === 'secret') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(spec));
      } else {
        res.statusCode = 401;
        res.end('no');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.json`;

    const doc = await loadInput(
      { path: url, headers: { 'x-token': 'secret' } },
      { cwd: fixtures, diagnostics: new Diagnostics() },
    );
    expect(doc.info.title).toBe('remote');

    const err = await loadInput(url, { cwd: fixtures, diagnostics: new Diagnostics() }).catch((e) => e);
    expect(err).toBeInstanceOf(ArchonError);
    expect((err as ArchonError).code).toBe('input-fetch-failed');
  });

  it('rejects swagger 2.0 with unsupported-version', async () => {
    const err = await loadInput(
      { swagger: '2.0', info: {}, paths: {} } as unknown as OpenAPIDocument,
      { cwd: fixtures, diagnostics: new Diagnostics() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ArchonError);
    expect((err as ArchonError).code).toBe('unsupported-version');
  });

  it('rejects unsupported openapi version', async () => {
    const err = await loadInput(
      { openapi: '4.0.0' },
      { cwd: fixtures, diagnostics: new Diagnostics() },
    ).catch((e) => e);
    expect((err as ArchonError).code).toBe('unsupported-version');
  });

  it('reports missing file as input-not-found', async () => {
    const err = await loadInput('nope.yaml', { cwd: fixtures, diagnostics: new Diagnostics() }).catch((e) => e);
    expect((err as ArchonError).code).toBe('input-not-found');
  });
});
