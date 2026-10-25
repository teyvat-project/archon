import { describe, expect, it } from 'vitest';
import * as dated from '../generated/dates/index.js';
import { createApiClient, getDates, getEnumValues, listPets, listShapes, type Shape } from '../generated/default/index.js';
import { baseUrl } from './support.js';

const client = createApiClient({ baseUrl });

function describeShape(shape: Shape): string {
  switch (shape.kind) {
    case 'circle':
      return `circle r=${shape.radius}`;
    case 'square':
      return `square s=${shape.side}`;
    default:
      return `unknown ${(shape as { kind: string }).kind}`;
  }
}

describe('unions', () => {
  it('narrows a discriminated union by kind and keeps an unknown variant as a plain value', async () => {
    const { data } = await listShapes({ client, throwOnError: true });
    expect(data).toEqual([
      { kind: 'circle', radius: 1 },
      { kind: 'square', side: 2 },
      { kind: 'hexagon', side: 3 },
    ]);
    expect(data.map(describeShape)).toEqual(['circle r=1', 'square s=2', 'unknown hexagon']);
  });

  it('receives an untagged union as is', async () => {
    const { data } = await listPets({ client, throwOnError: true });
    expect(data).toEqual([
      { name: 'Tama', meows: true },
      { name: 'Pochi', barks: true },
    ]);
    const sounds = data.map((pet) => ('meows' in pet ? 'meow' : 'woof'));
    expect(sounds).toEqual(['meow', 'woof']);
  });
});

describe('enums', () => {
  it('receives known and unknown enum values without failing', async () => {
    const { data } = await getEnumValues({ client, throwOnError: true });
    expect(data).toEqual({
      status: 'active',
      priority: 2,
      statuses: ['pending', 'archived'],
      color: null,
      level: 'unknown-level',
    });
  });
});

describe('dates', () => {
  it('keeps date strings as strings with the default options', async () => {
    const { data } = await getDates({ client, throwOnError: true });
    expect(data.createdAt).toBe('2026-10-25T12:34:56.789Z');
    expect(data.birthday).toBe('2000-01-02');
    expect(data.history[0]!.days[0]![0]).toBe('2026-10-01');
  });

  it("revives date-time and date values (including nested arrays) as Date with dates: 'Date'", async () => {
    const { data } = await dated.getDates({ client: dated.createApiClient({ baseUrl }), throwOnError: true });

    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.createdAt.toISOString()).toBe('2026-10-25T12:34:56.789Z');
    expect(data.birthday).toBeInstanceOf(Date);
    expect(data.birthday.toISOString()).toBe('2000-01-02T00:00:00.000Z');
    expect(data.updatedAt).toBeNull();

    expect(data.timestamps).toHaveLength(2);
    for (const t of data.timestamps!) expect(t).toBeInstanceOf(Date);
    expect(data.timestamps![1]!.toISOString()).toBe('2026-10-26T00:00:00.000Z');

    const entry = data.history[0]!;
    expect(entry.at).toBeInstanceOf(Date);
    expect(entry.days.flat()).toHaveLength(3);
    for (const day of entry.days.flat()) expect(day).toBeInstanceOf(Date);
    expect(entry.days[1]![0]!.toISOString()).toBe('2026-10-03T00:00:00.000Z');

    expect(data.byKey!['first']).toBeInstanceOf(Date);
    expect(data.byKey!['first']!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
