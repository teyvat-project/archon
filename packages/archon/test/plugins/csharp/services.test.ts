import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, file, generate, int, json, obj, operation, param, prop, ref, response, squash, str } from './helpers.js';

const T = 'global::System.Threading.Tasks.Task';
const CT = 'global::System.Threading.CancellationToken';

function petstore() {
  return doc(
    {
      Error: obj([prop('code', int, true), prop('message', str, true)]),
      Pet: obj([prop('id', int, true), prop('name', str, true)]),
    },
    [
      operation('GET /pets', 'listPets', {
        tags: ['pets'],
        group: 'pets',
        parameters: [param('limit', 'query', int), param('X-Request-Ids', 'header', arr(str), { required: true })],
        responses: [response(200, [json(arr(ref('Pet')))]), response('default', [json(ref('Error'))])],
      }),
      operation('GET /pets/{petId}', 'showPetById', {
        tags: ['pets'],
        group: 'pets',
        summary: 'Info for a specific pet',
        deprecated: true,
        parameters: [param('petId', 'path', str, { description: 'The id <of> the pet.' })],
        responses: [response(201, [json(ref('Pet'))]), response(200, [json(ref('Error'))]), response(404, [json(ref('Error'))]), response('4XX', [{ mediaType: 'text/plain', kind: 'text', schema: str }])],
        security: [{ schemes: [{ name: 'bearerAuth', scopes: ['read'] }] }, { schemes: [] }],
      }),
      operation('DELETE /pets/{petId}', 'deletePet', {
        tags: ['pets'],
        group: 'pets',
        parameters: [param('petId', 'path', str)],
        responses: [response(204)],
      }),
      operation('GET /health', 'getHealth', { responses: [response(200, [{ mediaType: 'text/plain', kind: 'text', schema: str }])] }),
    ],
  );
}

describe('csharp plugin: services', () => {
  it('orders parameters path, required, optional, then requestOptions and cancellationToken', async () => {
    const { files } = await generate(petstore(), { namespace: 'Test.Api' });
    const pets = file(files, 'Services/PetsService.cs');
    expect(pets).toContain('using Test.Api.Core;');
    expect(pets).toContain('public sealed partial class PetsService');
    expect(pets).toContain('internal PetsService(ApiClientCore core)');
    expect(squash(pets)).toContain(
      squash(`public async ${T}<global::System.Collections.Generic.List<Pet>> ListPetsAsync(global::System.Collections.Generic.IReadOnlyList<string> xRequestIds, int? limit = null, RequestOptions? requestOptions = null, ${CT} cancellationToken = default)
        => (await ListPetsWithResponseAsync(xRequestIds, limit, requestOptions, cancellationToken).ConfigureAwait(false)).Data;`),
    );
    expect(squash(pets)).toContain(
      squash(`var values = new RequestValues()
        .Query("limit", limit, ApiJsonContext.Default.NullableInt32)
        .Header("X-Request-Ids", xRequestIds, ApiJsonContext.Default.IReadOnlyListOfString);`),
    );
    expect(pets).toContain('return _core.SendAsync(ListPetsSpec, values, ResponseDecoder.Json(ApiJsonContext.Default.ListOfPet), ListPetsErrors, requestOptions, cancellationToken);');
  });

  it('emits OperationSpec with styles, security and responses', async () => {
    const { files } = await generate(petstore(), { namespace: 'Test.Api' });
    const pets = squash(file(files, 'Services/PetsService.cs'));
    expect(pets).toContain(
      squash(`private static readonly OperationSpec ShowPetByIdSpec = new(
        "showPetById",
        global::System.Net.Http.HttpMethod.Get,
        "/pets/{petId}",
        ["pets"],
        [new SecurityRequirement([new SecurityScheme("bearerAuth", ["read"])]), new SecurityRequirement([])],
        [new ParamSpec("petId", ParamLocation.Path, ParamStyle.Simple, false)],
        null,
        null,
        new global::System.Collections.Generic.Dictionary<string, ResponseKind> { ["201"] = ResponseKind.Json, ["200"] = ResponseKind.Json, ["404"] = ResponseKind.Json, ["4XX"] = ResponseKind.Text });`),
    );
    expect(pets).toContain(squash(`new ParamSpec("limit", ParamLocation.Query, ParamStyle.Form, true)`));
  });

  it('picks the lowest 2xx response type, documents and marks deprecated operations', async () => {
    const { files } = await generate(petstore(), { namespace: 'Test.Api' });
    const pets = file(files, 'Services/PetsService.cs');
    expect(pets).toContain(`public async ${T}<Error> ShowPetByIdAsync(string petId, RequestOptions? requestOptions = null, ${CT} cancellationToken = default)`);
    expect(pets).toContain('/// Info for a specific pet');
    expect(pets).toContain('/// <param name="petId">The id &lt;of&gt; the pet.</param>');
    expect(pets).toContain('[global::System.Obsolete]');
  });

  it('emits error decoders per status', async () => {
    const { files } = await generate(petstore(), { namespace: 'Test.Api' });
    const pets = squash(file(files, 'Services/PetsService.cs'));
    expect(pets).toContain(squash(`private static readonly ErrorDecoders ShowPetByIdErrors = new ErrorDecoders()
      .Json("404", ApiJsonContext.Default.Error)
      .Text("4XX");`));
    expect(pets).toContain('private static readonly ErrorDecoders DeletePetErrors = ErrorDecoders.None;');
  });

  it('returns Task for no-content operations and text as string', async () => {
    const { files } = await generate(petstore(), { namespace: 'Test.Api' });
    const pets = file(files, 'Services/PetsService.cs');
    expect(pets).toContain(`public async ${T} DeletePetAsync(string petId, RequestOptions? requestOptions = null, ${CT} cancellationToken = default)`);
    expect(pets).toContain(`public ${T}<ApiResult> DeletePetWithResponseAsync(`);
    expect(pets).toContain('return _core.SendAsync(DeletePetSpec, values, DeletePetErrors, requestOptions, cancellationToken);');
    const def = file(files, 'Services/DefaultService.cs');
    expect(def).toContain(`public async ${T}<string> GetHealthAsync(`);
    expect(def).toContain('ResponseDecoder.Text');
  });

  it('renames colliding parameter names and escapes keywords', async () => {
    const ir = doc({}, [
      operation('GET /a/{id}', 'getA', {
        parameters: [param('id', 'path', str), param('id', 'query', str), param('class', 'query', str), param('cancellationToken', 'query', str)],
        responses: [response(204)],
      }),
    ]);
    const { files } = await generate(ir);
    const svc = file(files, 'Services/DefaultService.cs');
    expect(svc).toContain(`GetAAsync(string id, string? id2 = null, string? @class = null, string? cancellationToken2 = null, RequestOptions? requestOptions = null, ${CT} cancellationToken = default)`);
    expect(svc).toContain('.Query("id", id2, ApiJsonContext.Default.String)');
    expect(svc).toContain('.Query("class", @class, ApiJsonContext.Default.String)');
  });

  it('encodes json, form, multipart, text and binary bodies', async () => {
    const multipart: IRMediaType = {
      mediaType: 'multipart/form-data',
      kind: 'multipart',
      schema: obj([prop('title', str, true), prop('count', int), prop('file', bin, true), prop('attachments', arr(bin))]),
    };
    const ir = doc({ Pet: obj([prop('name', str, true)]) }, [
      operation('POST /json', 'postJson', { requestBody: { required: true, contents: [json(ref('Pet'))] }, responses: [response(204)] }),
      operation('POST /opt', 'postOptional', { requestBody: { required: false, contents: [json(ref('Pet'))] }, responses: [response(204)] }),
      operation('POST /form', 'postForm', {
        requestBody: { required: true, contents: [{ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: obj([prop('a', str)]) }] },
        responses: [response(204)],
      }),
      operation('POST /raw-form', 'postRawForm', {
        requestBody: { required: true, contents: [{ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: str }] },
        responses: [response(204)],
      }),
      operation('POST /multipart', 'postMultipart', { requestBody: { required: true, contents: [multipart] }, responses: [response(204)] }),
      operation('POST /text', 'postText', { requestBody: { required: true, contents: [{ mediaType: 'text/plain', kind: 'text', schema: str }] }, responses: [response(204)] }),
      operation('POST /bin', 'postBinary', { requestBody: { required: true, contents: [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }] }, responses: [response(204)] }),
      operation('GET /ignored', 'getIgnored', { requestBody: { required: true, contents: [json(ref('Pet'))] }, responses: [response(204)] }),
    ]);
    const { files, diagnostics } = await generate(ir, { namespace: 'Test.Api' });
    const svc = squash(file(files, 'Services/DefaultService.cs'));
    expect(svc).toContain('PostJsonAsync(Pet body, RequestOptions? requestOptions = null');
    expect(svc).toContain('.JsonBody(body, ApiJsonContext.Default.Pet)');
    expect(svc).toContain('PostOptionalAsync(Pet? body = null, RequestOptions?');
    expect(svc).toContain('if (body is not null) values.JsonBody(body, ApiJsonContext.Default.Pet);');
    expect(svc).toContain('PostFormAsync(PostFormBody body,');
    expect(svc).toContain('.FormBody(body, ApiJsonContext.Default.PostFormBody)');
    expect(svc).toContain('PostRawFormAsync(FormBody body,');
    expect(svc).toContain('.Body(body)');
    expect(svc).toContain('PostMultipartAsync(PostMultipartBody body,');
    expect(svc).toContain(
      squash(`.Body(new MultipartBody()
        .AddJson("title", body.Title, ApiJsonContext.Default.String)
        .AddJson("count", body.Count, ApiJsonContext.Default.NullableInt32)
        .AddFile("file", body.File)
        .AddFiles("attachments", body.Attachments))`),
    );
    expect(svc).toContain('PostTextAsync(string body,');
    expect(svc).toContain('.TextBody(body)');
    expect(svc).toContain('PostBinaryAsync(global::Test.Api.Core.ApiFile body,');
    expect(svc).toContain('.BinaryBody(body)');
    expect(svc).toContain('GetIgnoredAsync(RequestOptions? requestOptions = null');
    expect(svc).toContain('BodyKind.Multipart, "multipart/form-data"');
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
  });

  it('sends a polymorphic variant body through its base so the discriminator is written', async () => {
    const ir = doc(
      {
        Shape: { kind: 'union', nullable: false, variants: [ref('Circle')], discriminator: { property: 'kind', mapping: new Map([['circle', 'Circle']]) } },
        Circle: obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('r', int, true)]),
      },
      [operation('POST /circles', 'postCircle', { requestBody: { required: true, contents: [json(ref('Circle'))] }, responses: [response(204)] })],
    );
    const { files } = await generate(ir);
    expect(file(files, 'Services/DefaultService.cs')).toContain('.JsonBody<Shape>(body, ApiJsonContext.Default.Shape)');
  });

  it('plugin include/exclude limits generated operations', async () => {
    const { files } = await generate(petstore(), { include: ['/^GET /pets/'], exclude: ['GET /pets/{petId}'] });
    const pets = file(files, 'Services/PetsService.cs');
    expect(pets).toContain('ListPetsAsync');
    expect(pets).not.toContain('ShowPetById');
    expect(files.has('Services/DefaultService.cs')).toBe(false);
    expect(files.has('Models/Pet.cs')).toBe(true);
  });

  it('uses methodName hook and naming.method template', async () => {
    const { files } = await generate(petstore(), {
      naming: { method: { name: '{{name}}Call' } },
      hooks: { methodName: (op) => (op.name === 'getHealth' ? 'Ping' : undefined) },
    });
    expect(file(files, 'Services/PetsService.cs')).toContain('ListPetsCall(');
    expect(file(files, 'Services/PetsService.cs')).toContain('ListPetsWithResponseCall(');
    expect(file(files, 'Services/DefaultService.cs')).toContain(' PingCall(');
  });

  it('symbols.operation returns generated names', async () => {
    const { api } = await generate(petstore());
    expect(api.symbols.operation('GET /pets')).toEqual({
      service: 'PetsService',
      property: 'Pets',
      method: 'ListPetsAsync',
      withResponseMethod: 'ListPetsWithResponseAsync',
      file: 'Services/PetsService.cs',
    });
    expect(() => api.symbols.operation('GET /nope')).toThrow(expect.objectContaining({ code: 'unknown-operation' }));
  });
});
