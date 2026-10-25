import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, getError, type NotFoundError } from '../generated/default/index.js';
import { baseUrl } from './support.js';

const client = createApiClient({ baseUrl });

describe('errors', () => {
  it('returns the success body for 200', async () => {
    const { data, error } = await getError({ client, path: { status: 200 } });
    expect(error).toBeUndefined();
    expect(data).toEqual({ ok: true });
  });

  it('returns a typed error body for 404', async () => {
    const { data, error, response } = await getError({ client, path: { status: 404 } });
    expect(data).toBeUndefined();
    expect(response.status).toBe(404);
    expect(error).toBeInstanceOf(ApiError);
    expect(error!.status).toBe(404);
    const body = error!.body as NotFoundError;
    expect(body).toEqual({ message: 'Not found', resource: 'errors/404' });
  });

  it('returns the 400 validation error body', async () => {
    const { error } = await getError({ client, path: { status: 400 } });
    expect(error!.status).toBe(400);
    expect(error!.body).toEqual({ message: 'Validation failed', fields: [{ name: 'status', reason: 'invalid' }] });
  });

  it('returns the default error body for any other status', async () => {
    const { error } = await getError({ client, path: { status: 418 } });
    expect(error!.status).toBe(418);
    expect(error!.body).toEqual({ code: 418, message: expect.any(String) });
  });

  it('throws ApiError with throwOnError', async () => {
    const call = getError({ client, path: { status: 404 }, throwOnError: true });
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 404, body: { resource: 'errors/404' } });
  });

  it('throws ApiError when the client is configured with throwOnError', async () => {
    const throwing = createApiClient({ baseUrl, throwOnError: true });
    await expect(getError({ client: throwing, path: { status: 500 } })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      body: { code: 500 },
    });
  });
});
