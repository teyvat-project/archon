import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  createNode,
  echoBinary,
  echoForm,
  echoJson,
  echoMultipart,
  echoText,
  type JsonPayload,
} from '../generated/default/index.js';
import { baseUrl } from './support.js';

const client = createApiClient({ baseUrl });

describe('request bodies', () => {
  it('sends a JSON body', async () => {
    const payload: JsonPayload = { name: 'archon', count: 3, tags: ['a', 'b'], note: null, nested: { flag: true } };
    const { data } = await echoJson({ client, throwOnError: true, body: payload });
    expect(data.method).toBe('POST');
    expect(data.contentType).toBe('application/json');
    expect(JSON.parse(data.body!)).toEqual(payload);
  });

  it('sends a URL-encoded form body with repeated array fields', async () => {
    const { data } = await echoForm({
      client,
      throwOnError: true,
      body: { name: 'a b&c', count: 2, tags: ['x', 'y'] },
    });
    expect(data.contentType).toBe('application/x-www-form-urlencoded');
    expect(data.body).toBe('name=a+b%26c&count=2&tags=x&tags=y');
  });

  it('sends a multipart body with file names and sizes', async () => {
    const { data } = await echoMultipart({
      client,
      throwOnError: true,
      body: {
        title: 'hello',
        file: new File([new Uint8Array(10)], 'data.bin', { type: 'application/octet-stream' }),
        attachments: [new File(['abc'], 'a.txt'), new File(['hello'], 'b.txt')],
      },
    });
    expect(data.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(JSON.parse(data.body!)).toEqual({ title: 'hello' });
    expect(data.files).toEqual([
      { field: 'file', name: 'data.bin', size: 10 },
      { field: 'attachments', name: 'a.txt', size: 3 },
      { field: 'attachments', name: 'b.txt', size: 5 },
    ]);
  });

  it('sends a binary body', async () => {
    const { data } = await echoBinary({
      client,
      throwOnError: true,
      body: new Blob([new TextEncoder().encode('raw bytes')]),
    });
    expect(data.contentType).toBe('application/octet-stream');
    expect(data.headers['content-length']).toBe('9');
    expect(data.body).toBe('raw bytes');
  });

  it('sends a plain-text body', async () => {
    const { data } = await echoText({ client, throwOnError: true, body: 'hello, text' });
    expect(data.contentType).toBe('text/plain');
    expect(data.body).toBe('hello, text');
  });

  it('round-trips a recursive allOf tree, the server assigning ids', async () => {
    const { data, response } = await createNode({
      client,
      throwOnError: true,
      body: {
        id: 'placeholder',
        name: 'root',
        labels: { env: 'test' },
        children: [
          { id: 'placeholder', name: 'a', children: [{ id: 'placeholder', name: 'a1', children: [] }] },
          { id: 'placeholder', name: 'b', children: [] },
        ],
      },
    });
    expect(response.status).toBe(201);
    expect(data).toEqual({
      id: 'n1',
      parentId: null,
      name: 'root',
      labels: { env: 'test' },
      children: [
        { id: 'n2', parentId: 'n1', name: 'a', children: [{ id: 'n3', parentId: 'n2', name: 'a1', children: [] }] },
        { id: 'n4', parentId: 'n1', name: 'b', children: [] },
      ],
    });
  });
});
