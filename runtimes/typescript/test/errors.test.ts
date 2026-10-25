import { describe, expect, it } from 'vitest';
import { ApiError, AuthError, DecodeError, TransportError } from '../src/errors.js';

describe('errors', () => {
  it('ApiError exposes status/body and name', () => {
    const response = new Response('{"code":"x"}', { status: 404 });
    const err = new ApiError(404, { code: 'x' }, response);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ code: 'x' });
    expect(err.response).toBe(response);
    expect(err.message).toBe('HTTP 404');
  });

  it('ApiError accepts a custom message', () => {
    const err = new ApiError(500, null, new Response(null, { status: 500 }), 'boom');
    expect(err.message).toBe('boom');
  });

  it('TransportError exposes cause and timedOut', () => {
    const cause = new TypeError('fetch failed');
    const err = new TransportError('network error', { cause, timedOut: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.name).toBe('TransportError');
    expect(err.cause).toBe(cause);
    expect(err.timedOut).toBe(true);
  });

  it('TransportError defaults timedOut to false', () => {
    const err = new TransportError('aborted', { cause: undefined });
    expect(err.timedOut).toBe(false);
  });

  it('DecodeError exposes raw and response', () => {
    const response = new Response('not json');
    const err = new DecodeError('invalid JSON', 'not json', response);
    expect(err).toBeInstanceOf(DecodeError);
    expect(err.name).toBe('DecodeError');
    expect(err.raw).toBe('not json');
    expect(err.response).toBe(response);
  });

  it('AuthError exposes schemes', () => {
    const err = new AuthError('missing credentials', ['bearerAuth', 'apiKey']);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe('AuthError');
    expect(err.schemes).toEqual(['bearerAuth', 'apiKey']);
  });
});
