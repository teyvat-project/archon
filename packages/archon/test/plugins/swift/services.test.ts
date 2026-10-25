import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, generate, int, json, obj, operation, param, prop, ref, response, source, squash, str } from './helpers.js';

const multipart = (schema: IRMediaType['schema']): IRMediaType => ({ mediaType: 'multipart/form-data', kind: 'multipart', schema });

describe('swift plugin: services', () => {
  it('orders arguments path, required body, required, optional body, optional, then options', async () => {
    const { files } = await generate(
      doc({ Pet: obj([prop('name', str, true)]) }, [
        operation('POST /pets/{id}', 'updatePet', {
          group: 'pets',
          parameters: [param('q', 'query', str), param('x-req', 'header', str, { required: true }), param('id', 'path', int)],
          requestBody: { required: true, contents: [json(ref('Pet'))] },
          responses: [response(200, [json(ref('Pet'))])],
        }),
      ]),
    );
    const pets = source(files, 'Services/PetsService.swift');
    expect(pets).toContain('public struct PetsService: Sendable {');
    expect(pets).toContain('public func updatePet(id: Int, body: Pet, xReq: String, q: String? = nil, options: RequestOptions? = nil) async throws -> Pet {');
    expect(pets).toContain('try await updatePetWithResponse(id: id, body: body, xReq: xReq, q: q, options: options).data');
    expect(pets).toContain('-> ApiResult<Pet> {');
    expect(squash(pets)).toContain(
      squash(`var values = RequestValues()
        try values.query("q", q)
        try values.header("x-req", xReq)
        try values.path("id", id)
        try values.json(body)
        return try await core.send(Self.updatePetSpec, values, decoder: .json(Pet.self), errors: Self.updatePetErrors, options: options)`),
    );
  });

  it('renames colliding and keyword parameter names', async () => {
    const { files } = await generate(
      doc({}, [
        operation('GET /x/{id}', 'getX', {
          parameters: [param('id', 'path', str), param('id', 'query', str), param('class', 'query', str), param('options', 'query', str)],
          responses: [response(204)],
        }),
      ]),
    );
    const service = source(files, 'Services/DefaultService.swift');
    expect(service).toContain('public func getX(id: String, id2: String? = nil, `class`: String? = nil, options2: String? = nil, options: RequestOptions? = nil) async throws {');
    expect(service).toContain('_ = try await getXWithResponse(id: id, id2: id2, class: `class`, options2: options2, options: options)');
    expect(service).toContain('try values.query("class", `class`)');
    expect(service).toContain('-> ApiResult<Void> {');
    expect(service).toContain('return try await core.send(Self.getXSpec, values, errors: Self.getXErrors, options: options)');
  });

  it('emits the operation spec and error decoders', async () => {
    const { files } = await generate(
      doc({ Err: obj([prop('code', int, true)]) }, [
        operation('GET /items', 'listItems', {
          group: 'items',
          tags: ['items'],
          parameters: [param('filter', 'query', obj([prop('a', str)]), { style: 'deepObject', explode: true }), param('r', 'query', str, { allowReserved: true })],
          security: [{ schemes: [{ name: 'oauth', scopes: ['read'] }] }, { schemes: [] }],
          responses: [
            response(201, [json(arr(str))]),
            response(200, [json(arr(int))]),
            response(404, [json(ref('Err'))]),
            response('5XX', [{ mediaType: 'text/plain', kind: 'text', schema: str }]),
            response('default', [json(ref('Err'))]),
          ],
        }),
      ]),
    );
    const items = source(files, 'Services/ItemsService.swift');
    expect(items).toContain('async throws -> [Int] {');
    expect(squash(items)).toContain(
      squash(`static let listItemsSpec = OperationSpec(
        operationName: "listItems",
        method: .get,
        path: "/items",
        tags: ["items"],
        security: [
          SecurityRequirement([SecurityScheme("oauth", scopes: ["read"])]),
          SecurityRequirement([]),
        ],
        params: [
          ParamSpec("filter", .query, .deepObject, explode: true),
          ParamSpec("r", .query, .form, explode: true, allowReserved: true),
        ],
        responses: ["201": .json, "200": .json, "404": .json, "5XX": .text, "default": .json]
      )`),
    );
    expect(squash(items)).toContain(squash('static let listItemsErrors = ErrorDecoders() .json("404", Err.self) .text("5XX") .json("default", Err.self)'));
  });

  it('builds multipart bodies with file parts and uses runtime types for raw bodies', async () => {
    const { files } = await generate(
      doc({}, [
        operation('POST /upload', 'upload', {
          requestBody: { required: false, contents: [multipart(obj([prop('title', str, true), prop('file', bin, true), prop('more', arr(bin))]))] },
          responses: [response(200, [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }])],
        }),
        operation('POST /raw', 'raw', {
          requestBody: { required: true, contents: [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }] },
          responses: [response(200, [{ mediaType: 'text/plain', kind: 'text', schema: str }])],
        }),
        operation('POST /parts', 'parts', { requestBody: { required: true, contents: [multipart(str)] }, responses: [response(204)] }),
      ]),
    );
    const service = source(files, 'Services/DefaultService.swift');
    expect(service).toContain('public func upload(body: UploadBody? = nil, options: RequestOptions? = nil) async throws -> Data {');
    expect(squash(service)).toContain(
      squash(`if let body {
        var multipart = MultipartBody()
        try multipart.field("title", body.title)
        multipart.file("file", body.file)
        multipart.files("more", body.more)
        values.multipart(multipart)
      }`),
    );
    expect(service).toContain('decoder: .binary,');
    expect(service).toContain('public func raw(body: Data, options: RequestOptions? = nil) async throws -> String {');
    expect(service).toContain('values.binary(body)');
    expect(service).toContain('public func parts(body: MultipartBody, options: RequestOptions? = nil) async throws {');
    expect(service).toContain('values.multipart(body)');
  });

  it('ignores GET bodies, honours include / exclude and marks deprecated operations', async () => {
    const ops = [
      operation('GET /a', 'getA', { requestBody: { required: true, contents: [json(str)] }, deprecated: true, responses: [response(204)] }),
      operation('GET /b', 'getB', { responses: [response(204)] }),
    ];
    const { files, diagnostics } = await generate(doc({}, ops), { exclude: ['GET /b'] });
    const service = source(files, 'Services/DefaultService.swift');
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
    expect(service).toContain('@available(*, deprecated)\n    public func getA(options: RequestOptions? = nil) async throws {');
    expect(service).not.toContain('getB');
  });

  it('applies the methodName hook and naming.method template', async () => {
    const ops = [operation('GET /a', 'getA', { responses: [response(204)] })];
    const hooked = await generate(doc({}, ops), { hooks: { methodName: () => 'fetch_everything' } });
    expect(source(hooked.files, 'Services/DefaultService.swift')).toContain('public func fetch_everything(');
    const templated = await generate(doc({}, ops), { naming: { method: { name: '{{name}}Call' } } });
    expect(source(templated.files, 'Services/DefaultService.swift')).toContain('public func getACall(');
    expect(templated.api.symbols.operation('GET /a')).toEqual({
      service: 'DefaultService',
      property: 'default',
      method: 'getACall',
      withResponseMethod: 'getAWithResponseCall',
      file: 'Sources/TestApi/Services/DefaultService.swift',
    });
  });
});
