import { describe, expect, it } from 'vitest';
import { createApiClient, getBinary, getEmpty, getEmptyJson, getText } from '../generated/default/index.js';
import { baseUrl } from './support.js';

const client = createApiClient({ baseUrl });

describe('response bodies', () => {
  it('decodes text/plain as a string', async () => {
    const { data, error } = await getText({ client });
    expect(error).toBeUndefined();
    expect(data).toBe('hello, archon');
  });

  it('decodes application/octet-stream as a Blob', async () => {
    const { data } = await getBinary({ client, throwOnError: true });
    expect(data).toBeInstanceOf(Blob);
    expect(data.size).toBe(256);
    const bytes = new Uint8Array(await data.arrayBuffer());
    expect(bytes[0]).toBe(0x00);
    expect(bytes[255]).toBe(0xff);
  });

  it('returns data === undefined for 204 No Content', async () => {
    const { data, error, response } = await getEmpty({ client });
    expect(response.status).toBe(204);
    expect(error).toBeUndefined();
    expect(data).toBeUndefined();
  });

  it('returns data === undefined for an empty body declared as JSON', async () => {
    const { data, error, response } = await getEmptyJson({ client });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(error).toBeUndefined();
    expect(data).toBeUndefined();
  });
});
