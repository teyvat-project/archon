import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, file, generate, int, json, nullable, obj, operation, param, prop, ref, response, str } from './helpers.js';

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
        parameters: [param('limit', 'query', int, { description: 'How many.' }), param('X-Request-Ids', 'header', arr(str), { required: true })],
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
      operation('DELETE /pets/{petId}', 'deletePet', { tags: ['pets'], group: 'pets', parameters: [param('petId', 'path', str)], responses: [response(204)] }),
      operation('GET /health', 'getHealth', { responses: [response(200, [{ mediaType: 'text/plain', kind: 'text', schema: str }])] }),
    ],
  );
}

const body = (media: IRMediaType, required = true) => ({ required, contents: [media] });

describe('go plugin: services', () => {
  it('emits a Params struct, the method and its operation spec', async () => {
    const { files } = await generate(petstore());
    const pets = file(files, 'pets_service.go');
    expect(pets).toContain('import (\n\t"context"\n\t"net/http"\n\n\t"api/core"\n)');
    expect(pets).toContain('// PetsService holds the operations of the group "pets".\ntype PetsService struct {\n\tclient *core.Client\n}');
    expect(pets).toContain('// ListPetsParams are the parameters of PetsService.ListPets.\ntype ListPetsParams struct {\n\t// How many.\n\tLimit       *int\n\tXRequestIds []string\n}');
    expect(pets).toContain('// ListPets sends GET /pets.\nfunc (s *PetsService) ListPets(ctx context.Context, params ListPetsParams, opts ...core.RequestOption) ([]Pet, *http.Response, error) {');
    expect(pets).toContain('\tvalues := core.NewValues()\n\tvalues.Query("limit", params.Limit)\n\tvalues.Header("X-Request-Ids", params.XRequestIds)\n');
    expect(pets).toContain('\treturn core.Do(ctx, s.client, listPetsOperation, values, core.DecodeJSON[[]Pet], listPetsErrors, opts)');
    expect(pets).toContain(
      [
        'var listPetsOperation = &core.OperationSpec{',
        '\tName:   "listPets",',
        '\tMethod: "GET",',
        '\tPath:   "/pets",',
        '\tTags:   []string{"pets"},',
        '\tParams: []core.ParamSpec{',
        '\t\t{Name: "limit", In: core.InQuery, Style: core.StyleForm, Explode: true},',
        '\t\t{Name: "X-Request-Ids", In: core.InHeader, Style: core.StyleSimple},',
        '\t},',
        '\tResponses: map[string]core.ResponseKind{"200": core.ResponseJSON, "default": core.ResponseJSON},',
        '}',
      ].join('\n'),
    );
    expect(pets).toContain('var listPetsErrors = core.ErrorDecoders{\n\t"default": core.JSONError[Error],\n}');
  });

  it('returns the lowest 2xx type, documents and deprecates, and lists security and error decoders', async () => {
    const { files } = await generate(petstore());
    const pets = file(files, 'pets_service.go');
    expect(pets).toContain(
      '// ShowPetById sends GET /pets/{petId}.\n//\n// Info for a specific pet\n//\n// Deprecated: Deprecated in the API.\nfunc (s *PetsService) ShowPetById(ctx context.Context, params ShowPetByIdParams, opts ...core.RequestOption) (*Error, *http.Response, error) {',
    );
    expect(pets).toContain('\t// The id of the pet.\n\tPetId string\n');
    expect(pets).toContain('\tSecurity: []core.SecurityRequirement{\n\t\t{{Name: "bearerAuth", Scopes: []string{"read"}}},\n\t\t{},\n\t},');
    expect(pets).toContain('var showPetByIdErrors = core.ErrorDecoders{\n\t"404": core.JSONError[Error],\n\t"4XX": core.TextError,\n}');
    expect(pets).toContain('func (s *PetsService) DeletePet(ctx context.Context, params DeletePetParams, opts ...core.RequestOption) (*http.Response, error) {');
    expect(pets).toContain('\t_, resp, err := core.Do(ctx, s.client, deletePetOperation, values, core.DecodeNone, deletePetErrors, opts)\n\treturn resp, err');
    expect(pets).toContain('var deletePetErrors core.ErrorDecoders');

    const defaults = file(files, 'default_service.go');
    expect(defaults).toContain('// DefaultService holds the operations without a group.');
    expect(defaults).toContain('func (s *DefaultService) GetHealth(ctx context.Context, opts ...core.RequestOption) (string, *http.Response, error) {');
    expect(defaults).toContain('return core.Do(ctx, s.client, getHealthOperation, nil, core.DecodeText, getHealthErrors, opts)');
  });

  it('takes bodies as a separate argument', async () => {
    const upload = obj([prop('title', str, true), prop('file', bin, true), prop('more', arr(bin)), prop('cover', bin)]);
    const ir = doc({ Pet: obj([prop('name', str, true)]), Upload: upload }, [
      operation('POST /json', 'postJson', { requestBody: body(json(ref('Pet'))), responses: [response(204)] }),
      operation('PUT /json', 'putJson', { requestBody: body(json(ref('Pet')), false), responses: [response(204)] }),
      operation('POST /form', 'postForm', { requestBody: body({ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: ref('Pet') }), responses: [response(204)] }),
      operation('POST /raw-form', 'postRawForm', { requestBody: body({ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: str }), responses: [response(204)] }),
      operation('POST /multipart', 'postMultipart', { requestBody: body({ mediaType: 'multipart/form-data', kind: 'multipart', schema: ref('Upload') }), responses: [response(204)] }),
      operation('POST /text', 'postText', { requestBody: body({ mediaType: 'text/plain', kind: 'text', schema: str }, false), responses: [response(204)] }),
      operation('POST /binary', 'postBinary', {
        requestBody: body({ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }),
        responses: [response(200, [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }])],
      }),
      operation('GET /get-body', 'getBody', { requestBody: body(json(ref('Pet'))), responses: [response(204)] }),
      operation('GET /nullable', 'getNullable', { responses: [response(200, [json(nullable(str))])] }),
    ]);
    const { files, diagnostics } = await generate(ir);
    const svc = file(files, 'default_service.go');
    expect(svc).toContain('PostJson(ctx context.Context, body Pet, opts ...core.RequestOption) (*http.Response, error) {\n\tvalues := core.NewValues()\n\tvalues.JSONBody(body)');
    expect(svc).toContain('PutJson(ctx context.Context, body *Pet, opts ...core.RequestOption) (*http.Response, error) {\n\tvalues := core.NewValues()\n\tif body != nil {\n\t\tvalues.JSONBody(body)\n\t}');
    expect(svc).toContain('PostForm(ctx context.Context, body Pet, opts ...core.RequestOption)');
    expect(svc).toContain('\tvalues.FormBody(body)');
    expect(svc).toContain('PostRawForm(ctx context.Context, body *core.FormBody, opts ...core.RequestOption)');
    expect(svc).toContain('\tvalues.Body(body)');
    expect(svc).toContain(
      '\tmp := core.NewMultipart()\n\tmp.Field("title", body.Title)\n\tmp.File("file", &body.File)\n\tmp.Files("more", body.More)\n\tmp.File("cover", body.Cover)\n\tvalues.Body(mp)',
    );
    expect(svc).toContain('PostText(ctx context.Context, body *string, opts ...core.RequestOption)');
    expect(svc).toContain('\t\tvalues.TextBody(*body)');
    expect(svc).toContain('PostBinary(ctx context.Context, body core.File, opts ...core.RequestOption) ([]byte, *http.Response, error) {');
    expect(svc).toContain('core.DecodeBinary');
    expect(svc).toContain('GetBody(ctx context.Context, opts ...core.RequestOption) (*http.Response, error)');
    expect(svc).toContain('GetNullable(ctx context.Context, opts ...core.RequestOption) (*string, *http.Response, error)');
    expect(svc).toContain('\tBody:      core.BodyMultipart,\n\tMediaType: "multipart/form-data",');
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
  });

  it('applies include / exclude, naming and the methodName hook', async () => {
    const { files, api } = await generate(petstore(), { exclude: ['GET /health'], naming: { method: { name: 'Do{{name}}' } }, hooks: { methodName: (op) => (op.name === 'deletePet' ? 'Remove' : undefined) } });
    expect(files.has('default_service.go')).toBe(false);
    const pets = file(files, 'pets_service.go');
    expect(pets).toContain('func (s *PetsService) DoListPets(');
    expect(pets).toContain('func (s *PetsService) DoRemove(');
    expect(api.symbols.operation('DELETE /pets/{petId}')).toEqual({ service: 'PetsService', field: 'Pets', method: 'DoRemove', params: 'DoRemoveParams', file: 'pets_service.go' });
    expect(api.symbols.typeOf('Pet')).toEqual({ name: 'Pet', importPath: 'api', file: 'pet_model.go' });
    expect(() => api.symbols.operation('GET /health')).toThrow(/Unknown operation/);
  });
});
