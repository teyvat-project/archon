import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, file, generate, int, json, nullable, obj, operation, param, prop, ref, response, str } from './helpers.js';

function petstore() {
  return doc(
    {
      Error: obj([prop('code', int, true), prop('message', str, true)]),
      Pet: obj([prop('id', int, true), prop('name', str, true)]),
      Filter: obj([prop('minAge', int)]),
    },
    [
      operation('GET /pets', 'listPets', {
        group: 'pets',
        tags: ['pets'],
        parameters: [
          param('limit', 'query', int, { description: 'How many.', deprecated: true }),
          param('X-Request-Ids', 'header', arr(str), { required: true }),
          param('filter', 'query', ref('Filter'), { style: 'deepObject' }),
          param('body', 'query', str),
          param('end', 'cookie', str),
        ],
        responses: [response(200, [json(arr(ref('Pet')))]), response('default', [json(ref('Error'))])],
      }),
      operation('GET /pets/{petId}', 'showPetById', {
        group: 'pets',
        summary: 'Info for a specific pet',
        deprecated: true,
        parameters: [param('petId', 'path', str)],
        responses: [
          response(201, [json(ref('Pet'))]),
          response(200, [json(nullable(ref('Error')))]),
          response(404, [json(ref('Error'))]),
          response('4XX', [{ mediaType: 'text/plain', kind: 'text', schema: str }]),
        ],
        security: [{ schemes: [{ name: 'bearerAuth', scopes: ['read'] }] }, { schemes: [] }],
      }),
      operation('DELETE /pets/{petId}', 'deletePet', { group: 'pets', parameters: [param('petId', 'path', str)], responses: [response(204)] }),
      operation('GET /health', 'getHealth', { responses: [response(200, [{ mediaType: 'text/plain', kind: 'text', schema: str }])] }),
      operation('GET /send', 'send', { group: 'core', responses: [response(200, [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }])] }),
    ],
  );
}

const body = (media: IRMediaType, required = true) => ({ required, contents: [media] });

describe('ruby plugin: services', () => {
  it('renders methods with keyword parameters, coercion of model arguments and the operation constant', async () => {
    const { files } = await generate(petstore());
    const pets = file(files, 'lib/api/services/pets.rb');
    expect(pets).toContain("  # The operations of the group 'pets'.\n  class PetsService\n");
    expect(pets).toContain('    # @param limit [::Integer, nil] How many. (deprecated in the API)\n');
    expect(pets).toContain('    # @param filter [Filter, ::Hash, nil]\n');
    expect(pets).toContain('    # @return [::Array<Pet>, nil]\n');
    expect(pets).toContain('    def list_pets(limit: nil, x_request_ids:, filter: nil, body2: nil, end_: nil, request_options: nil, &on_response)\n');
    expect(pets).toContain(
      [
        '      values = Core::Values.new',
        "      values.query('limit', limit)",
        "      values.header('X-Request-Ids', x_request_ids)",
        "      values.query('filter', Filter.coerce(filter))",
        "      values.query('body', body2)",
        "      values.cookie('end', end_)",
        '      @client.call(LIST_PETS, values, request_options, &on_response)',
      ].join('\n'),
    );
    expect(pets).toContain(
      [
        '    LIST_PETS = Core::Operation.new(',
        "      name: 'listPets',",
        "      http_method: 'GET',",
        "      path: '/pets',",
        "      tags: ['pets'],",
        '      params: [',
        "        Core::ParamSpec.new(name: 'limit', location: :query, style: :form, explode: true),",
        "        Core::ParamSpec.new(name: 'X-Request-Ids', location: :header, style: :simple),",
        "        Core::ParamSpec.new(name: 'filter', location: :query, style: :deep_object, explode: true),",
        "        Core::ParamSpec.new(name: 'body', location: :query, style: :form, explode: true),",
        "        Core::ParamSpec.new(name: 'end', location: :cookie, style: :form, explode: true),",
        '      ],',
        '      success: :json,',
        '      result: Core::Types.array(Core::Types.ref(-> { Pet })),',
        '      errors: {',
        "        'default' => Core::Types.ref(-> { Error }),",
        '      },',
        '    )',
      ].join('\n'),
    );
    expect(pets).toContain('    private_constant :LIST_PETS, :SHOW_PET_BY_ID, :DELETE_PET\n');
  });

  it('decodes the lowest 2xx, maps errors and security, and documents deprecation', async () => {
    const pets = file((await generate(petstore())).files, 'lib/api/services/pets.rb');
    expect(pets).toContain('    # Info for a specific pet\n    #\n    # `GET /pets/{petId}`\n    #\n    # @deprecated Deprecated in the API.\n    #\n');
    expect(pets).toContain('    def show_pet_by_id(pet_id:, request_options: nil, &on_response)\n');
    expect(pets).toContain("      security: [{ 'bearerAuth' => ['read'] }, {}],\n");
    expect(pets).toContain("      result: Core::Types.ref(-> { Error }),\n      errors: {\n        '404' => Core::Types.ref(-> { Error }),\n        '4XX' => :text,\n      },\n");
    expect(pets).toContain('    # @return [nil]\n');
    expect(pets).toContain('    def delete_pet(pet_id:, request_options: nil, &on_response)\n');
    expect(pets).toMatch(/DELETE_PET = Core::Operation\.new\(\n\s+name: 'deletePet',\n\s+http_method: 'DELETE',\n\s+path: '\/pets\/\{petId\}',\n\s+params: \[\n.*\n\s+\],\n\s+\)/);
  });

  it('puts operations without a group in DefaultService and escapes clashing names', async () => {
    const { files, api } = await generate(petstore());
    const health = file(files, 'lib/api/services/default.rb');
    expect(health).toContain('  # The operations without a group.\n  class DefaultService\n');
    expect(health).toContain('    def get_health(request_options: nil, &on_response)\n      @client.call(GET_HEALTH, nil, request_options, &on_response)\n');
    expect(health).toContain('      success: :text,\n');
    const core = file(files, 'lib/api/services/core.rb');
    expect(core).toContain('  class CoreService\n');
    expect(core).toContain('    def send_(request_options: nil, &on_response)\n');
    expect(core).toContain('      success: :binary,\n');
    expect(file(files, 'lib/api/client.rb')).toContain('    attr_reader :core_\n');
    expect(api.symbols.operation('GET /send')).toEqual({ service: 'Api::CoreService', reader: 'core_', method: 'send_', file: 'lib/api/services/core.rb' });
  });

  it('takes the body as the first argument in every encoding', async () => {
    const payload = obj([prop('title', str, true), prop('file', bin, true)]);
    const ir = doc({ Payload: payload }, [
      operation('POST /json', 'postJson', { requestBody: body(json(ref('Payload'))), parameters: [param('id', 'path', str)] }),
      operation('POST /optional', 'postOptional', { requestBody: body(json(ref('Payload')), false) }),
      operation('POST /form', 'postForm', { requestBody: body({ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: ref('Payload') }) }),
      operation('POST /multipart', 'postMultipart', { requestBody: body({ mediaType: 'multipart/form-data', kind: 'multipart', schema: ref('Payload') }) }),
      operation('POST /loose', 'postLoose', { requestBody: body({ mediaType: 'multipart/form-data', kind: 'multipart', schema: { kind: 'unknown', nullable: false } }) }),
      operation('POST /text', 'postText', { requestBody: body({ mediaType: 'text/plain', kind: 'text', schema: str }) }),
      operation('POST /binary', 'postBinary', { requestBody: body({ mediaType: 'image/png', kind: 'binary', schema: bin }) }),
      operation('POST /array', 'postArray', { requestBody: body(json(arr(int))) }),
      operation('GET /ignored', 'getIgnored', { requestBody: body(json(str)) }),
    ]);
    const { files, diagnostics } = await generate(ir);
    const service = file(files, 'lib/api/services/default.rb');
    expect(service).toContain("    def post_json(body, id:, request_options: nil, &on_response)\n      values = Core::Values.new\n      values.path('id', id)\n      values.json_body(Payload.coerce(body))\n");
    expect(service).toContain('    def post_optional(body = nil, request_options: nil, &on_response)\n      values = Core::Values.new\n      values.json_body(Payload.coerce(body)) unless body.nil?\n');
    expect(service).toContain('      values.form_body(Payload.coerce(body))\n');
    expect(service).toContain('      values.multipart_body(Payload.coerce(body))\n');
    expect(service).toContain('    # @param body [::Hash, Core::MultipartBody]\n');
    expect(service).toContain('      values.multipart_body(body)\n');
    expect(service).toContain('      values.text_body(body)\n');
    expect(service).toContain("      values.binary_body(body)\n");
    expect(service).toContain("      body: :binary,\n      media_type: 'image/png',\n");
    expect(service).toContain('      values.json_body(body)\n');
    expect(service).toContain('    def get_ignored(request_options: nil, &on_response)\n');
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
  });

  it('honours include / exclude and the methodName hook', async () => {
    const { files } = await generate(petstore(), { exclude: ['DELETE /pets/{petId}'], hooks: { methodName: (op) => (op.name === 'listPets' ? 'allPets' : undefined) } });
    const pets = file(files, 'lib/api/services/pets.rb');
    expect(pets).toContain('    def all_pets(');
    expect(pets).not.toContain('delete_pet');
  });
});
