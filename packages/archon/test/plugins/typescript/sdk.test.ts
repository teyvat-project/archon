import { describe, expect, it } from 'vitest';
import { ArchonError } from '../../../src/diagnostics.js';
import type { IRDocument, IRSchema } from '../../../src/ir/types.js';
import {
  arr,
  date,
  dateTime,
  file,
  generate,
  json,
  obj,
  operation,
  petstore,
  prop,
  ref,
  response,
  str,
} from './helpers.js';

const sdkOf = async (ir: IRDocument, opts: Parameters<typeof generate>[1] = {}) =>
  file((await generate(ir, opts)).files, 'sdk.gen.ts');

describe('typescript plugin: sdk.gen.ts', () => {
  it('generates data/response/error types and spec constant', async () => {
    const sdk = await sdkOf(petstore());

    expect(sdk.startsWith('// Generated header\n\n')).toBe(true);
    expect(sdk).toContain("import { client } from './client.gen.js';");
    expect(sdk).toContain("import type { Client, OperationSpec } from './core/index.js';");
    expect(sdk).toContain("import type { Error, NewPet, Pet } from './types.gen.js';");
    expect(sdk).toContain(
      [
        'export type Options<TData, ThrowOnError extends boolean = boolean> = TData & {',
        '  client?: Client<any>;',
        '  signal?: AbortSignal;',
        '  throwOnError?: ThrowOnError;',
        '  extensions?: { [key: string]: unknown };',
        '  baseUrl?: string;',
        '};',
      ].join('\n'),
    );

    expect(sdk).toContain(
      [
        'export type ShowPetByIdData = {',
        '  path: {',
        '    petId: string;',
        '  };',
        '};',
        '',
        'export type ShowPetByIdResponses = {',
        '  200: Pet;',
        '};',
        '',
        'export type ShowPetByIdResponse = ShowPetByIdResponses[keyof ShowPetByIdResponses];',
        '',
        'export type ShowPetByIdErrors = {',
        '  404: Error;',
        '  default: Error;',
        '};',
        '',
        'export type ShowPetByIdError = ShowPetByIdErrors[keyof ShowPetByIdErrors];',
        '',
        'const showPetByIdSpec: OperationSpec = {',
        "  operationName: 'showPetById',",
        "  method: 'GET',",
        "  path: '/pets/{petId}',",
        "  tags: ['pets'],",
        "  security: [[{ scheme: 'bearerAuth', scopes: ['read'] }], []],",
        '  params: [',
        "    { name: 'petId', in: 'path', style: 'simple', explode: false },",
        '  ],',
        "  responses: { '200': 'json', '404': 'json', default: 'json' },",
        '};',
        '',
        '/**',
        ' * Info for a specific pet',
        ' *',
        ' * Returns a single pet.',
        ' * @deprecated',
        ' */',
        'export const showPetById = <ThrowOnError extends boolean = false>(options: Options<ShowPetByIdData, ThrowOnError>) =>',
        '  (options.client ?? client).request<ShowPetByIdResponse, ShowPetByIdError, ThrowOnError>(showPetByIdSpec, options);',
      ].join('\n'),
    );

    // query / header は元の名前をキーにし、必須パラメータが無ければ optional
    expect(sdk).toContain(
      [
        'export type ListPetsData = {',
        '  query?: {',
        '    limit?: number;',
        '  };',
        '  headers?: {',
        "    'x-trace'?: string;",
        '  };',
        '};',
      ].join('\n'),
    );
    expect(sdk).toContain('export type ListPetsResponses = {\n  200: Pet[];\n};');
    expect(sdk).toContain(
      [
        '  params: [',
        "    { name: 'limit', in: 'query', style: 'form', explode: true },",
        "    { name: 'x-trace', in: 'header', style: 'simple', explode: false },",
        '  ],',
      ].join('\n'),
    );
    expect(sdk).toContain("  security: [],\n  params: [\n    { name: 'limit'");

    // required body
    expect(sdk).toContain('export type CreatePetData = {\n  body: NewPet;\n};');
    expect(sdk).toContain("  body: { kind: 'json', mediaType: 'application/json' },\n  responses: { '201': 'json', default: 'json' },");
    expect(sdk).toContain("  security: [[{ scheme: 'bearerAuth', scopes: [] }]],");

    // 2xx / エラーが無い操作
    expect(sdk).toContain('export type GetHealthData = {};');
    expect(sdk).toContain('export type GetHealthResponses = {\n  200: string;\n};');
    expect(sdk).toContain('export type GetHealthErrors = {};');
    expect(sdk).toContain('export type GetHealthError = unknown;');
    expect(sdk).toContain("  params: [],\n  responses: { '200': 'text' },");
  });

  it('uses void for empty success responses and unknown when there is no 2xx', async () => {
    const ir = petstore();
    ir.operations = [
      operation('DELETE /pets/{petId}', 'deletePet', {
        responses: [response(204), response(404)],
      }),
      operation('GET /broken', 'broken', { responses: [response(500, [json(ref('Error'))])] }),
    ];
    const sdk = await sdkOf(ir);
    expect(sdk).toContain('export type DeletePetResponses = {\n  204: void;\n};');
    expect(sdk).toContain('export type DeletePetErrors = {\n  404: unknown;\n};');
    expect(sdk).toContain("  responses: { '204': 'empty', '404': 'empty' },");
    expect(sdk).toContain('export type BrokenResponses = {};');
    expect(sdk).toContain('export type BrokenResponse = unknown;');
  });

  it('makes options optional when nothing is required', async () => {
    const ir = petstore();
    ir.operations.push(
      operation('GET /search', 'search', {
        parameters: [
          { ...paramOf('q', 'query'), required: true },
          paramOf('page', 'query'),
          paramOf('X-Request-Id', 'header'),
          { ...paramOf('session', 'cookie'), required: true },
        ],
        responses: [response(200, [json(arr(ref('Pet')))])],
      }),
    );
    const sdk = await sdkOf(ir);
    expect(sdk).toContain('(options: Options<GetHealthData, ThrowOnError> = {}) =>');
    expect(sdk).toContain('(options: Options<ListPetsData, ThrowOnError> = {}) =>');
    expect(sdk).toContain('(options: Options<UploadPhotoData, ThrowOnError>) =>');
    expect(sdk).toContain('(options: Options<CreatePetData, ThrowOnError>) =>');
    expect(sdk).toContain('(options: Options<SearchData, ThrowOnError>) =>');
    expect(sdk).toContain(
      [
        'export type SearchData = {',
        '  query: {',
        '    q: string;',
        '    page?: string;',
        '  };',
        '  headers?: {',
        "    'X-Request-Id'?: string;",
        '  };',
        '  cookies: {',
        '    session: string;',
        '  };',
        '};',
      ].join('\n'),
    );
  });

  it('class style groups by tag', async () => {
    const sdk = await sdkOf(petstore(), { sdk: { style: 'class' } });
    expect(sdk).not.toContain('export const listPets');
    expect(sdk).toContain('const listPetsSpec: OperationSpec = {');
    expect(sdk).toContain('export type ListPetsData = {');
    expect(sdk).toContain(
      [
        'export class Default {',
        '  static getHealth = <ThrowOnError extends boolean = false>(options: Options<GetHealthData, ThrowOnError> = {}) =>',
        '    (options.client ?? client).request<GetHealthResponse, GetHealthError, ThrowOnError>(getHealthSpec, options);',
        '}',
      ].join('\n'),
    );
    expect(sdk).toContain('export class Pets {\n  static listPets = <ThrowOnError extends boolean = false>');
    expect(sdk).toContain('\n\n  /**\n   * Info for a specific pet\n');
    expect(sdk).toContain('  static showPetById = <ThrowOnError extends boolean = false>');
  });

  it('uses methodName hook', async () => {
    const { files, api } = await generate(petstore(), {
      hooks: { methodName: (op) => (op.id === 'GET /pets' ? 'fetchAllPets' : undefined) },
      naming: { method: { name: '{{name}}Op' } },
    });
    const sdk = file(files, 'sdk.gen.ts');
    expect(sdk).toContain('export type FetchAllPetsData = {');
    expect(sdk).toContain('const fetchAllPetsSpec: OperationSpec = {');
    expect(sdk).toContain('export const fetchAllPets = <ThrowOnError');
    expect(sdk).toContain("  operationName: 'listPets',");
    expect(sdk).toContain('export const createPetOp = <ThrowOnError');
    expect(api.symbols.operation('GET /pets')).toEqual({
      functionName: 'fetchAllPets',
      dataType: 'FetchAllPetsData',
      responseType: 'FetchAllPetsResponse',
      errorType: 'FetchAllPetsError',
      file: 'sdk.gen.ts',
    });
  });

  it('omits body for GET and includes body kind for multipart', async () => {
    const ir = petstore();
    ir.operations.push(
      operation('GET /query', 'queryWithBody', {
        requestBody: { required: true, contents: [json(ref('NewPet'))] },
        responses: [response(200, [json(ref('Pet'))])],
      }),
    );
    const { files, diagnostics } = await generate(ir);
    const sdk = file(files, 'sdk.gen.ts');
    expect(sdk).toContain('export type QueryWithBodyData = {};');
    expect(specBlock(sdk, 'queryWithBody')).not.toContain('body:');
    expect(diagnostics.entries).toContainEqual(expect.objectContaining({ level: 'warn', code: 'request-body-ignored' }));

    expect(sdk).toContain(
      [
        'export type UploadPhotoData = {',
        '  path: {',
        '    petId: string;',
        '  };',
        '  body?: {',
        '    file: Blob;',
        '    caption?: string;',
        '  };',
        '};',
      ].join('\n'),
    );
    expect(sdk).toContain(
      "  body: { kind: 'multipart', mediaType: 'multipart/form-data' },\n  responses: { '204': 'empty' },",
    );
    expect(sdk).toContain('export type UploadPhotoResponses = {\n  204: void;\n};');
  });

  it('plugin include/exclude limits generated operations', async () => {
    const { files, api } = await generate(petstore(), { include: ['/^GET /'], exclude: ['GET /health'] });
    const sdk = file(files, 'sdk.gen.ts');
    expect(sdk).toContain('export const listPets =');
    expect(sdk).toContain('export const showPetById =');
    expect(sdk).not.toContain('createPet');
    expect(sdk).not.toContain('getHealth');
    expect(sdk).not.toContain('uploadPhoto');
    // 型は出力する
    expect(file(files, 'types.gen.ts')).toContain('export type NewPet = {');
    expect(() => api.symbols.operation('GET /health')).toThrow(ArchonError);
  });

  it('symbols.operation returns generated names', async () => {
    const { api } = await generate(petstore());
    expect(api.symbols.operation('GET /pets/{petId}')).toEqual({
      functionName: 'showPetById',
      dataType: 'ShowPetByIdData',
      responseType: 'ShowPetByIdResponse',
      errorType: 'ShowPetByIdError',
      file: 'sdk.gen.ts',
    });
    expect(() => api.symbols.operation('GET /missing')).toThrow(ArchonError);

    const classApi = (await generate(petstore(), { sdk: { style: 'class' } })).api;
    expect(classApi.symbols.operation('GET /health').functionName).toBe('Default.getHealth');
  });

  it('avoids collisions between operation names, schema names and runtime exports', async () => {
    const ir = petstore();
    ir.schemas.set('ListPetsData', obj([]));
    ir.schemas.set('Client', obj([]));
    ir.schemas.set('Options', obj([]));
    ir.operations.push(
      operation('GET /client', 'client', {
        responses: [response(200, [json(ref('Client'))])],
      }),
      operation('GET /delete', 'delete', { responses: [response(204)] }),
    );
    const { files, api } = await generate(ir);
    const sdk = file(files, 'sdk.gen.ts');
    expect(api.symbols.typeOf('Client').name).toBe('Client2');
    expect(api.symbols.typeOf('Options').name).toBe('Options2');
    expect(sdk).toContain('export type ListPetsData2 = {');
    expect(sdk).toContain('export const client2 = <ThrowOnError');
    expect(sdk).toContain('export const delete_ = <ThrowOnError');
    expect(sdk).toContain("import type { Client2, Error, NewPet, Pet } from './types.gen.js';");
  });

  it('dates=Date generates transformer and wires it into spec', async () => {
    const ir = petstore();
    ir.schemas.set(
      'Event',
      obj([
        prop('at', date, true),
        prop('pet', ref('Pet')),
        prop('history', arr(arr(dateTime))),
        prop('x-when', dateTime),
        prop('labels', obj([], { additionalProperties: dateTime })),
      ]),
    );
    const circle = obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('at', dateTime)]);
    ir.schemas.set('Circle', circle);
    ir.schemas.set('Square', obj([prop('kind', { kind: 'const', value: 'square', nullable: false }, true)]));
    const shape: IRSchema = {
      kind: 'union',
      nullable: false,
      variants: [ref('Circle'), ref('Square'), dateTime],
      discriminator: { property: 'kind', mapping: new Map([['circle', 'Circle'], ['square', 'Square']]) },
    };
    ir.schemas.set('Shape', shape);
    ir.operations.push(
      operation('GET /events', 'listEvents', {
        responses: [response(200, [json(arr(ref('Event')))]), response(206, [json(ref('Shape'))])],
      }),
    );

    const { files } = await generate(ir, { dates: 'Date' });
    const transformers = file(files, 'transformers.gen.ts');
    expect(transformers.startsWith('// Generated header\n\n')).toBe(true);
    expect(transformers).toContain(
      [
        'export function transformPet(data: any): any {',
        '  if (isObject(data)) {',
        "    if (typeof data.createdAt === 'string') data.createdAt = new Date(data.createdAt);",
        '  }',
        '  return data;',
        '}',
      ].join('\n'),
    );
    expect(transformers).toContain(
      [
        'export function transformEvent(data: any): any {',
        '  if (isObject(data)) {',
        "    if (typeof data.at === 'string') data.at = new Date(data.at);",
        '    if (data.pet !== undefined) data.pet = transformPet(data.pet);',
        '    if (Array.isArray(data.history)) {',
        '      for (let i0 = 0; i0 < data.history.length; i0++) {',
        '        if (Array.isArray(data.history[i0])) {',
        '          for (let i1 = 0; i1 < data.history[i0].length; i1++) {',
        "            if (typeof data.history[i0][i1] === 'string') data.history[i0][i1] = new Date(data.history[i0][i1]);",
        '          }',
        '        }',
        '      }',
        '    }',
        "    if (typeof data['x-when'] === 'string') data['x-when'] = new Date(data['x-when']);",
        '    if (isObject(data.labels)) {',
        '      for (const k0 of Object.keys(data.labels)) {',
        "        if (typeof data.labels[k0] === 'string') data.labels[k0] = new Date(data.labels[k0]);",
        '      }',
        '    }',
        '  }',
        '  return data;',
        '}',
      ].join('\n'),
    );
    // 判別ありの union は discriminator を確認してから変換する
    expect(transformers).toContain(
      [
        'export function transformShape(data: any): any {',
        "  if (isObject(data) && data.kind === 'circle') {",
        '    data = transformCircle(data);',
        '  }',
        "  if (typeof data === 'string') data = new Date(data);",
        '  return data;',
        '}',
      ].join('\n'),
    );
    expect(transformers).not.toContain('transformSquare');
    expect(transformers).not.toContain('transformError');

    const sdk = file(files, 'sdk.gen.ts');
    expect(sdk).toContain(
      "import { transformListEventsResponse, transformListPetsResponse, transformPet } from './transformers.gen.js';",
    );
    expect(specBlock(sdk, 'showPetById')).toContain("  responses: { '200': 'json', '404': 'json', default: 'json' },\n  transform: transformPet,\n};");
    expect(specBlock(sdk, 'listEvents')).toContain('  transform: transformListEventsResponse,\n};');
    expect(specBlock(sdk, 'listPets')).toContain('  transform: transformListPetsResponse,\n};');
    expect(specBlock(sdk, 'getHealth')).not.toContain('transform');
    // 複数の 2xx は union として防御的に変換する
    expect(transformers).toContain(
      [
        'export function transformListEventsResponse(data: any): any {',
        '  if (Array.isArray(data)) {',
        '    for (let i0 = 0; i0 < data.length; i0++) {',
        '      data[i0] = transformEvent(data[i0]);',
        '    }',
        '  }',
        '  data = transformShape(data);',
        '  return data;',
        '}',
      ].join('\n'),
    );
  });

  it('emits no transformers with dates=string', async () => {
    const { files } = await generate(petstore());
    expect(files.has('transformers.gen.ts')).toBe(false);
    expect(file(files, 'sdk.gen.ts')).not.toContain('transform');
  });
});

function paramOf(name: string, where: 'query' | 'header' | 'cookie') {
  return {
    name,
    in: where,
    required: false,
    deprecated: false,
    schema: str,
    style: where === 'header' ? ('simple' as const) : ('form' as const),
    explode: where !== 'header',
    allowReserved: false,
  };
}

/** `const <name>Spec: OperationSpec = {` から対応する `};` までを返す。 */
function specBlock(sdk: string, name: string): string {
  const start = sdk.indexOf(`const ${name}Spec: OperationSpec = {`);
  if (start < 0) throw new Error(`spec of ${name} not found`);
  return sdk.slice(start, sdk.indexOf('\n};', start) + 3);
}

describe('typescript plugin: error types with dates=Date', () => {
  // Error bodies are never transformed by the runtime, so their dates stay strings.
  const problem = obj([prop('timestamp', dateTime, true), prop('detail', str)]);
  const errorDatesIR = (): IRDocument => ({
    info: { title: 'Error Dates', version: '1.0.0' },
    servers: [],
    securitySchemes: new Map(),
    schemas: new Map<string, IRSchema>([
      ['Problem', problem],
      ['Plain', obj([prop('message', str, true)])],
    ]),
    operations: [
      operation('GET /thing', 'getThing', {
        responses: [
          response(200, [json(ref('Problem'))]),
          response(400, [json(obj([prop('timestamp', dateTime, true)]))]),
          response(404, [json(ref('Problem'))]),
          response(409, [json(arr(ref('Problem')))]),
          response('default', [json(ref('Plain'))]),
        ],
      }),
    ],
  });

  it('renders inline error dates as string and wraps named date-bearing schemas in DatesAsString', async () => {
    const sdk = await sdkOf(errorDatesIR(), { dates: 'Date' });
    expect(sdk).toContain(
      [
        'export type GetThingErrors = {',
        '  400: {',
        '    timestamp: string;',
        '  };',
        '  404: DatesAsString<Problem>;',
        '  409: DatesAsString<Problem[]>;',
        '  default: Plain;',
        '};',
      ].join('\n'),
    );
    expect(sdk).toContain('export type GetThingResponses = {\n  200: Problem;\n};');
    expect(sdk).toContain(
      [
        '/**',
        ' * Error bodies are not transformed, so `Date` members of shared schemas stay JSON strings.',
        ' */',
        'export type DatesAsString<T> = T extends Date',
        '  ? string',
        '  : T extends Blob',
        '    ? T',
        '    : T extends object',
        '      ? { [K in keyof T]: DatesAsString<T[K]> }',
        '      : T;',
      ].join('\n'),
    );
  });

  it('does not emit the helper with dates=string or when no error needs it', async () => {
    expect(await sdkOf(errorDatesIR())).not.toContain('DatesAsString');
    expect(await sdkOf(petstore(), { dates: 'Date' })).not.toContain('DatesAsString');
  });

  it('avoids a schema named DatesAsString', async () => {
    const ir = errorDatesIR();
    ir.schemas.set('DatesAsString', str);
    const sdk = await sdkOf(ir, { dates: 'Date' });
    expect(sdk).toContain('  404: DatesAsString2<Problem>;');
    expect(sdk).toContain('export type DatesAsString2<T> = T extends Date');
  });
});

describe('typescript plugin: unknown schema names', () => {
  it('warns and renders unknown instead of throwing', async () => {
    const ir: IRDocument = {
      info: { title: 'Ghosts', version: '1.0.0' },
      servers: [],
      securitySchemes: new Map(),
      schemas: new Map<string, IRSchema>([['Holder', obj([prop('ghost', ref('Ghost'), true)])]]),
      operations: [operation('GET /ghost', 'getGhost', { responses: [response(200, [json(ref('Ghost'))])] })],
    };
    const { files, diagnostics } = await generate(ir);
    expect(file(files, 'sdk.gen.ts')).toContain('export type GetGhostResponses = {\n  200: unknown;\n};');
    expect(file(files, 'types.gen.ts')).toContain('  ghost: unknown;');
    const warns = diagnostics.entries.filter((d) => d.code === 'unknown-schema');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((d) => d.level === 'warn' && d.message.includes('"Ghost"'))).toBe(true);
  });
});
