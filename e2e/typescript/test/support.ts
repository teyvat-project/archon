import { inject } from 'vitest';

export const baseUrl = inject('baseUrl');
export const secondaryUrl = inject('secondaryUrl');

export type Stats = { tokensIssued: number; requests: Record<string, number> };

/** The mock server's counters (`GET /__stats`). */
export async function stats(): Promise<Stats> {
  const response = await fetch(new URL('/__stats', baseUrl));
  return (await response.json()) as Stats;
}

/** How many requests the mock server received for `path` (raw path, without the query string). */
export async function requestCount(path: string): Promise<number> {
  return (await stats()).requests[path] ?? 0;
}
