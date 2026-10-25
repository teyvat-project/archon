import { json, type Route } from '../http.js';

export const unionRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/unions\/shapes$/,
    handle: () =>
      json(200, [
        { kind: 'circle', radius: 1 },
        { kind: 'square', side: 2 },
        { kind: 'hexagon', side: 3 },
      ]),
  },
  {
    method: 'GET',
    path: /^\/unions\/untagged$/,
    handle: () =>
      json(200, [
        { name: 'Tama', meows: true },
        { name: 'Pochi', barks: true },
      ]),
  },
  {
    method: 'GET',
    path: /^\/enums$/,
    handle: () =>
      json(200, {
        status: 'active',
        priority: 2,
        statuses: ['pending', 'archived'],
        color: null,
        level: 'unknown-level',
      }),
  },
  {
    method: 'GET',
    path: /^\/dates$/,
    handle: () =>
      json(200, {
        createdAt: '2026-10-25T12:34:56.789Z',
        birthday: '2000-01-02',
        updatedAt: null,
        timestamps: ['2026-10-25T09:00:00+09:00', '2026-10-26T00:00:00Z'],
        history: [
          {
            at: '2026-10-25T00:00:00Z',
            days: [['2026-10-01', '2026-10-02'], ['2026-10-03']],
          },
        ],
        byKey: { first: '2026-01-01T00:00:00Z' },
      }),
  },
];
