import { describe, expect, it } from 'vitest';
import { decodeBody, encodeBody } from '../src/body.js';
import { DecodeError } from '../src/errors.js';

describe('encodeBody', () => {
  it('encodes json with the declared media type', () => {
    expect(encodeBody('json', 'application/json', { a: 1 })).toEqual({
      body: '{"a":1}',
      contentType: 'application/json',
      replayable: true,
    });
    expect(encodeBody('json', 'application/vnd.api+json', [1]).contentType).toBe('application/vnd.api+json');
  });

  it('encodes form with repeated keys for arrays and JSON for nested objects', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    const result = encodeBody('form', 'application/x-www-form-urlencoded', {
      a: 'x y',
      tags: ['t1', 't2'],
      nested: { k: 1 },
      at: date,
      skip: undefined,
      none: null,
      flag: true,
    });
    expect(result.contentType).toBe('application/x-www-form-urlencoded');
    expect(result.replayable).toBe(true);
    expect(result.body).toBeInstanceOf(URLSearchParams);
    expect(String(result.body)).toBe(
      'a=x+y&tags=t1&tags=t2&nested=%7B%22k%22%3A1%7D&at=2024-01-02T03%3A04%3A05.000Z&flag=true',
    );
  });

  it('encodes multipart with Blobs appended directly and objects as JSON strings', () => {
    const file = new Blob(['hello'], { type: 'text/plain' });
    const result = encodeBody('multipart', 'multipart/form-data', {
      file,
      meta: { a: 1 },
      ids: [1, 2],
      at: new Date('2024-01-02T03:04:05.000Z'),
      name: 'n',
      skip: undefined,
      none: null,
    });
    expect(result.contentType).toBeUndefined();
    expect(result.replayable).toBe(true);
    const form = result.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('meta')).toBe('{"a":1}');
    expect(form.getAll('ids')).toEqual(['1', '2']);
    expect(form.get('at')).toBe('2024-01-02T03:04:05.000Z');
    expect(form.get('name')).toBe('n');
    expect(form.has('skip')).toBe(false);
    expect(form.has('none')).toBe(false);
  });

  it('encodes text', () => {
    expect(encodeBody('text', 'text/plain', 42)).toEqual({ body: '42', contentType: 'text/plain', replayable: true });
  });

  it('encodes binary as-is and marks streams as non-replayable', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(encodeBody('binary', 'application/octet-stream', bytes)).toEqual({
      body: bytes,
      contentType: 'application/octet-stream',
      replayable: true,
    });
    const blob = new Blob(['x']);
    expect(encodeBody('binary', 'image/png', blob).body).toBe(blob);
    const buffer = new ArrayBuffer(2);
    expect(encodeBody('binary', 'application/octet-stream', buffer).body).toBe(buffer);
    expect(encodeBody('binary', 'application/octet-stream', 'raw').body).toBe('raw');

    const stream = new ReadableStream<Uint8Array>();
    const result = encodeBody('binary', 'application/octet-stream', stream);
    expect(result.body).toBe(stream);
    expect(result.replayable).toBe(false);
  });
});

describe('decodeBody', () => {
  it('decodes json', async () => {
    expect(await decodeBody('json', new Response('{"a":1}'))).toEqual({ a: 1 });
  });

  it('decodes empty json body as undefined', async () => {
    expect(await decodeBody('json', new Response(''))).toBeUndefined();
    expect(await decodeBody('json', new Response(null, { status: 204 }))).toBeUndefined();
    expect(await decodeBody('json', new Response(null, { status: 205 }))).toBeUndefined();
  });

  it('throws DecodeError on invalid json', async () => {
    const response = new Response('not json');
    const error = await decodeBody('json', response).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).raw).toBe('not json');
    expect((error as DecodeError).response).toBe(response);
  });

  it('decodes text, binary and empty', async () => {
    expect(await decodeBody('text', new Response('hi'))).toBe('hi');
    const blob = await decodeBody('binary', new Response(new Uint8Array([1, 2])));
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(await decodeBody('empty', new Response('ignored'))).toBeUndefined();
  });
});
