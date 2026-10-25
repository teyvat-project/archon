import { describe, expect, it } from 'vitest';
import { createApiClient, echoHeadersCookies, echoPathStyles, echoQueryStyles } from '../generated/default/index.js';
import { baseUrl } from './support.js';

const client = createApiClient({ baseUrl, throwOnError: true });

describe('parameter serialization', () => {
  it('serializes all path styles', async () => {
    const { data } = await echoPathStyles({
      client,
      throwOnError: true,
      path: { simple: ['a', 'b'], label: ['a', 'b'], matrix: { x: 1, y: 2 } },
    });
    expect(data.method).toBe('GET');
    expect(data.path).toBe('/echo/path/a,b/.a.b/;x=1;y=2');
    expect(data.query).toBe('');
  });

  it('percent-encodes reserved characters so a path value stays in one segment', async () => {
    const { data } = await echoPathStyles({
      client,
      throwOnError: true,
      path: { simple: ['a/b?c#d e', '日本'], label: ['x'], matrix: { x: 1, y: 2 } },
    });
    expect(data.path).toBe('/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2');
  });

  it('serializes all query styles', async () => {
    const { data } = await echoQueryStyles({
      client,
      throwOnError: true,
      query: {
        formExploded: ['a', 'b'],
        formFlat: ['a', 'b'],
        spaced: ['a', 'b'],
        piped: [1, 2],
        filter: { status: 'active', minAge: 3 },
        reserved: 'a/b?c:d',
        limit: 10,
      },
    });
    expect(data.path).toBe('/echo/query');
    expect(data.query).toBe(
      [
        'formExploded=a&formExploded=b',
        'formFlat=a,b',
        'spaced=a%20b',
        'piped=1|2',
        'filter[status]=active&filter[minAge]=3',
        'reserved=a/b?c:d',
        'limit=10',
      ].join('&'),
    );
  });

  it('omits query parameters that are not set', async () => {
    const { data } = await echoQueryStyles({ client, throwOnError: true, query: { limit: 1 } });
    expect(data.query).toBe('limit=1');
  });

  it('sends header array and cookies', async () => {
    const { data } = await echoHeadersCookies({
      client,
      throwOnError: true,
      headers: { 'X-Request-Ids': ['a', 'b'], 'X-Trace': 'trace-1' },
      cookies: { theme: 'dark', tags: ['x', 'y'] },
    });
    expect(data.headers['x-request-ids']).toBe('a,b');
    expect(data.headers['x-trace']).toBe('trace-1');
    expect(data.headers['cookie']).toBe('theme=dark; tags=x,y');
    expect(data.cookies).toEqual({ theme: 'dark', tags: 'x,y' });
  });
});
