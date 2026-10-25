import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../../src/diagnostics.js';
import type { OpenAPIDocument } from '../../src/loader/load.js';
import { applyPatch } from '../../src/loader/patch.js';

const make = (): OpenAPIDocument => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: { '/pets': { get: { operationId: 'listPets' } } },
  components: { schemas: { Pet: { type: 'object' } } },
});

describe('applyPatch', () => {
  it('applies document, schemas and operations patches in order', () => {
    const doc = make();
    const order: string[] = [];
    const d = new Diagnostics();
    applyPatch(
      doc,
      {
        operations: { 'get /pets': (op) => { order.push('op'); op.summary = 'patched'; } },
        schemas: { Pet: (s) => { order.push('schema'); s.description = 'patched'; } },
        document: (x) => { order.push('doc'); x.info.title = 'patched'; },
      },
      d,
    );
    expect(order).toEqual(['doc', 'schema', 'op']);
    expect(doc.info.title).toBe('patched');
    expect(doc.components.schemas.Pet.description).toBe('patched');
    expect(doc.paths['/pets'].get.summary).toBe('patched');
    expect(d.entries).toEqual([]);
  });

  it('warns patch-target-missing for unknown operation', () => {
    const d = new Diagnostics();
    applyPatch(make(), { operations: { 'POST /nope': () => {} } }, d);
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]).toMatchObject({ level: 'warn', code: 'patch-target-missing' });
  });

  it('warns patch-target-missing for unknown schema', () => {
    const d = new Diagnostics();
    applyPatch(make(), { schemas: { Nope: () => {} } }, d);
    expect(d.entries[0]).toMatchObject({ level: 'warn', code: 'patch-target-missing' });
  });

  it('does nothing when patch is undefined', () => {
    const doc = make();
    applyPatch(doc, undefined, new Diagnostics());
    expect(doc).toEqual(make());
  });
});
