import { describe, expect, it } from 'vitest';
import { createApiClient, redirectCrossOrigin } from '../generated/default/index.js';
import { baseUrl, secondaryUrl } from './support.js';

describe('redirects', () => {
  it('drops credentials when a redirect crosses origins', async () => {
    const client = createApiClient({
      baseUrl,
      auth: { apiKeyHeader: 'test-key' },
      headers: { Authorization: 'Bearer test-token' },
    });
    const { data, response } = await redirectCrossOrigin({ client, throwOnError: true });
    expect(response.status).toBe(200);
    expect(new URL(response.url).origin).toBe(new URL(secondaryUrl).origin);
    expect(data.path).toBe('/echo/headers');
    expect(data.headers['x-api-key']).toBeUndefined();
    expect(data.headers['authorization']).toBeUndefined();
  });
});
