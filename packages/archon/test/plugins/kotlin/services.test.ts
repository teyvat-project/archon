import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, file, generate, int, json, nullable, obj, operation, param, prop, ref, response, SRC, squash, str } from './helpers.js';

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
        parameters: [param('petId', 'path', str, { description: 'The id of the pet.' })],
        responses: [
          response(201, [json(ref('Pet'))]),
          response(200, [json(ref('Error'))]),
          response(404, [json(ref('Error'))]),
          response('4XX', [{ mediaType: 'text/plain', kind: 'text', schema: str }]),
        ],
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

const pets = (files: Map<string, string>) => file(files, `${SRC}/services/PetsService.kt`);
const defaults = (files: Map<string, string>) => file(files, `${SRC}/services/DefaultService.kt`);

describe('kotlin plugin: services', () => {
  it('orders parameters path, required, optional, then requestOptions', async () => {
    const { files } = await generate(petstore());
    const svc = pets(files);
    expect(svc).toContain('package test.api.services');
    expect(svc).toContain('import test.api.core.ApiClientCore');
    expect(svc).toContain('import test.api.core.RequestValues');
    expect(svc).toContain('import test.api.models.*');
    expect(svc).toContain('import io.ktor.http.HttpMethod');
    expect(svc).toContain('public class PetsService internal constructor(private val core: ApiClientCore) {');
    expect(squash(svc)).toContain(
      squash(`public suspend fun listPets(xRequestIds: List<String>, limit: Int? = null, requestOptions: RequestOptions? = null): List<Pet> =
        listPetsWithResponse(xRequestIds, limit, requestOptions).data`),
    );
    expect(squash(svc)).toContain(
      squash(`public suspend fun listPetsWithResponse(xRequestIds: List<String>, limit: Int? = null, requestOptions: RequestOptions? = null): ApiResult<List<Pet>> {
        val values = RequestValues()
          .query("limit", limit, Int.serializer().nullable)
          .header("X-Request-Ids", xRequestIds, ListSerializer(String.serializer()))
        return core.send(LIST_PETS, values, ResponseDecoder.json(ListSerializer(Pet.serializer())), LIST_PETS_ERRORS, requestOptions)
      }`),
    );
  });

  it('emits OperationSpec with styles, security and responses', async () => {
    const { files } = await generate(petstore());
    const svc = squash(pets(files));
    expect(svc).toContain(
      squash(`val SHOW_PET_BY_ID: OperationSpec = OperationSpec(
        "showPetById",
        HttpMethod.Get,
        "/pets/{petId}",
        listOf("pets"),
        listOf(SecurityRequirement(listOf(SecurityScheme("bearerAuth", listOf("read")))), SecurityRequirement(emptyList())),
        listOf(ParamSpec("petId", ParamLocation.Path, ParamStyle.Simple, false)),
        null,
        null,
        mapOf("201" to ResponseKind.Json, "200" to ResponseKind.Json, "404" to ResponseKind.Json, "4XX" to ResponseKind.Text),
      )`),
    );
    expect(svc).toContain('ParamSpec("limit", ParamLocation.Query, ParamStyle.Form, true)');
    expect(svc).toContain('private companion object {');
  });

  it('picks the lowest 2xx response type, documents and marks deprecated operations', async () => {
    const { files } = await generate(petstore());
    const svc = pets(files);
    expect(svc).toContain('public suspend fun showPetById(petId: String, requestOptions: RequestOptions? = null): Error =');
    expect(squash(svc)).toContain(squash('/** * Info for a specific pet * * @param petId The id of the pet. */ @Deprecated("Deprecated in the API.") public suspend fun showPetById('));
  });

  it('returns Unit for no-content operations and String for text', async () => {
    const { files } = await generate(petstore());
    const svc = pets(files);
    expect(svc).toContain('public suspend fun deletePet(petId: String, requestOptions: RequestOptions? = null): Unit =');
    expect(svc).toContain('): ApiResult<Unit> {');
    expect(svc).toContain('return core.send(DELETE_PET, values, ResponseDecoder.empty, DELETE_PET_ERRORS, requestOptions)');
    const def = defaults(files);
    expect(def).toContain('public suspend fun getHealth(requestOptions: RequestOptions? = null): String =');
    expect(def).toContain('ResponseDecoder.text');
    expect(def).toContain('val values = RequestValues()\n');
  });

  it('keeps a nullable success type nullable', async () => {
    const ir = doc({ Pet: obj([prop('id', int, true)]) }, [
      operation('GET /maybe', 'maybePet', { responses: [response(200, [json(nullable(ref('Pet')))])] }),
      operation('GET /bytes', 'getBytes', { responses: [response(200, [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }])] }),
    ]);
    const svc = defaults((await generate(ir)).files);
    expect(svc).toContain('public suspend fun maybePet(requestOptions: RequestOptions? = null): Pet? =');
    expect(svc).toContain('ResponseDecoder.json(Pet.serializer().nullable)');
    expect(svc).toContain('public suspend fun getBytes(requestOptions: RequestOptions? = null): ByteArray =');
    expect(svc).toContain('ResponseDecoder.binary');
  });

  it('emits error decoders per status', async () => {
    const { files } = await generate(petstore());
    const svc = squash(pets(files));
    expect(svc).toContain(squash(`val SHOW_PET_BY_ID_ERRORS: ErrorDecoders = ErrorDecoders()
      .json("404", Error.serializer())
      .text("4XX")`));
    expect(svc).toContain('val DELETE_PET_ERRORS: ErrorDecoders = ErrorDecoders.None');
  });

  it('renames colliding parameter names and escapes keywords', async () => {
    const ir = doc({}, [
      operation('GET /a/{id}', 'getA', {
        parameters: [param('id', 'path', str), param('id', 'query', str), param('in', 'query', str), param('values', 'query', str), param('core', 'header', str)],
        responses: [response(204)],
      }),
    ]);
    const svc = defaults((await generate(ir)).files);
    expect(svc).toContain('getA(id: String, id2: String? = null, `in`: String? = null, values2: String? = null, core2: String? = null, requestOptions: RequestOptions? = null)');
    expect(svc).toContain('.query("id", id2, String.serializer().nullable)');
    expect(svc).toContain('.query("in", `in`, String.serializer().nullable)');
    expect(svc).not.toContain('import test.api.models.*');
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
      operation('POST /bin', 'postBinary', {
        requestBody: { required: true, contents: [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }] },
        responses: [response(204)],
      }),
      operation('GET /ignored', 'getIgnored', { requestBody: { required: true, contents: [json(ref('Pet'))] }, responses: [response(204)] }),
    ]);
    const { files, diagnostics } = await generate(ir);
    const svc = squash(defaults(files));
    expect(svc).toContain('postJson(body: Pet, requestOptions: RequestOptions? = null)');
    expect(svc).toContain('.jsonBody(body, Pet.serializer())');
    expect(svc).toContain('postOptional(body: Pet? = null, requestOptions: RequestOptions? = null)');
    expect(svc).toContain('if (body != null) values.jsonBody(body, Pet.serializer())');
    expect(svc).toContain('postForm(body: PostFormBody,');
    expect(svc).toContain('.formBody(body, PostFormBody.serializer())');
    expect(svc).toContain('postRawForm(body: FormBody,');
    expect(svc).toContain('.body(body)');
    expect(svc).toContain('postMultipart(body: PostMultipartBody,');
    expect(svc).toContain(
      squash(`.body(
        MultipartBody()
          .addJson("title", body.title, String.serializer())
          .addJson("count", body.count, Int.serializer().nullable)
          .addFile("file", body.file)
          .addFiles("attachments", body.attachments),
      )`),
    );
    expect(svc).toContain('postText(body: String,');
    expect(svc).toContain('.textBody(body)');
    expect(svc).toContain('postBinary(body: ApiFile,');
    expect(svc).toContain('.binaryBody(body)');
    expect(svc).toContain('getIgnored(requestOptions: RequestOptions? = null)');
    expect(svc).toContain('BodyKind.Multipart, "multipart/form-data",');
    expect(svc).toContain('HttpMethod.Post,');
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
  });

  it('plugin include/exclude limits generated operations', async () => {
    const { files } = await generate(petstore(), { include: ['/^GET /pets/'], exclude: ['GET /pets/{petId}'] });
    const svc = pets(files);
    expect(svc).toContain('listPets(');
    expect(svc).not.toContain('showPetById');
    expect(files.has(`${SRC}/services/DefaultService.kt`)).toBe(false);
    expect(files.has(`${SRC}/models/Pet.kt`)).toBe(true);
  });

  it('uses methodName hook and naming.method template', async () => {
    const { files } = await generate(petstore(), {
      naming: { method: { name: '{{name}}Call' } },
      hooks: { methodName: (op) => (op.name === 'getHealth' ? 'ping' : undefined) },
    });
    expect(pets(files)).toContain('listPetsCall(');
    expect(pets(files)).toContain('listPetsWithResponseCall(');
    expect(defaults(files)).toContain(' pingCall(');
  });

  it('symbols.operation returns generated names', async () => {
    const { api } = await generate(petstore());
    expect(api.symbols.operation('GET /pets')).toEqual({
      service: 'PetsService',
      property: 'pets',
      method: 'listPets',
      withResponseMethod: 'listPetsWithResponse',
      file: `${SRC}/services/PetsService.kt`,
    });
    expect(() => api.symbols.operation('GET /nope')).toThrow(expect.objectContaining({ code: 'unknown-operation' }));
  });
});
