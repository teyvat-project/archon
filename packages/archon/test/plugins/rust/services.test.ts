import { describe, expect, it } from 'vitest';
import type { IRMediaType } from '../../../src/ir/types.js';
import { arr, bin, doc, file, generate, int, json, nullable, obj, operation, param, prop, ref, response, squash, str } from './helpers.js';

const text: IRMediaType = { mediaType: 'text/plain', kind: 'text', schema: str };

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
          response(200, [json(nullable(ref('Pet')))]),
          response(404, [json(ref('Error'))]),
          response('4XX', [text]),
        ],
        security: [{ schemes: [{ name: 'bearerAuth', scopes: ['read'] }] }, { schemes: [] }],
      }),
      operation('DELETE /pets/{petId}', 'deletePet', { tags: ['pets'], group: 'pets', parameters: [param('petId', 'path', str)], responses: [response(204)] }),
      operation('GET /health', 'getHealth', { responses: [response(200, [text])] }),
    ],
  );
}

const pets = (files: Map<string, string>) => file(files, 'src/services/pets.rs');

describe('rust plugin: services', () => {
  it('takes required parameters positionally and optional ones through setters', async () => {
    const svc = squash(pets((await generate(petstore())).files));
    expect(svc).toContain(squash('use crate::core; use crate::models;'));
    expect(svc).toContain(squash('#[derive(Debug, Clone)] pub struct PetsService { core: std::sync::Arc<core::ApiClientCore>, }'));
    expect(svc).toContain(
      squash(`pub fn list_pets(&self, x_request_ids: impl Into<Vec<String>>) -> ListPetsRequest {
        ListPetsRequest { core: self.core.clone(), x_request_ids: x_request_ids.into(), limit: None, options: core::RequestOptions::default(), } }`),
    );
    expect(svc).toContain(squash('/// How many. pub fn limit(mut self, value: impl Into<i64>) -> Self { self.limit = Some(value.into()); self }'));
    expect(svc).toContain(
      squash(`pub async fn send(self) -> Result<core::ApiResponse<Vec<models::Pet>>, core::Error<ListPetsError>> {
        let values = core::RequestValues::new()
            .query("limit", &self.limit)
            .header("X-Request-Ids", &self.x_request_ids);
        self.core.send(&LIST_PETS, values, core::decode_json, self.options).await }`),
    );
    expect(svc).toContain(
      squash(`impl std::future::IntoFuture for ListPetsRequest {
        type Output = Result<core::ApiResponse<Vec<models::Pet>>, core::Error<ListPetsError>>;
        type IntoFuture = core::BoxFuture<'static, Self::Output>;
        fn into_future(self) -> Self::IntoFuture { Box::pin(self.send()) } }`),
    );
  });

  it('documents and deprecates operations', async () => {
    const svc = squash(pets((await generate(petstore())).files));
    expect(svc).toContain(squash('/// Info for a specific pet /// /// - `pet_id`: The id of the pet. #[deprecated] pub fn show_pet_by_id(&self, pet_id: impl Into<String>) -> ShowPetByIdRequest {'));
  });

  it('emits the operation spec as a static', async () => {
    const svc = squash(pets((await generate(petstore())).files));
    expect(svc).toContain(
      squash(`static SHOW_PET_BY_ID: core::OperationSpec = core::OperationSpec {
        operation_name: "showPetById",
        method: core::Method::GET,
        path: "/pets/{petId}",
        tags: &["pets"],
        security: &[
            core::SecurityRequirement { schemes: &[core::SecurityScheme { name: "bearerAuth", scopes: &["read"] }] },
            core::SecurityRequirement { schemes: &[] },
        ],
        params: &[
            core::ParamSpec { name: "petId", location: core::ParamLocation::Path, style: core::ParamStyle::Simple, explode: false, allow_reserved: false },
        ],
        body: None,
        body_media_type: None,
        responses: &[("201", core::ResponseKind::Json), ("200", core::ResponseKind::Json), ("404", core::ResponseKind::Json), ("4XX", core::ResponseKind::Text)],
      };`),
    );
  });

  it('picks the lowest 2xx type, keeps a nullable one nullable, and returns () without content', async () => {
    const svc = squash(pets((await generate(petstore())).files));
    expect(svc).toContain(squash('pub async fn send(self) -> Result<core::ApiResponse<Option<models::Pet>>, core::Error<ShowPetByIdError>> {'));
    expect(svc).toContain(squash('pub async fn send(self) -> Result<core::ApiResponse<()>, core::Error> {'));
    expect(svc).toContain(squash('self.core.send(&DELETE_PET, values, core::decode_empty, self.options).await'));
    const health = squash(file((await generate(petstore())).files, 'src/services/default.rs'));
    expect(health).toContain(squash('pub async fn send(self) -> Result<core::ApiResponse<String>, core::Error> {'));
    expect(health).toContain('core::decode_text');
    expect(health).not.toContain('use crate::models;');
  });

  it('emits an error enum decoding by exact status, range, then default', async () => {
    const svc = squash(pets((await generate(petstore())).files));
    expect(svc).toContain(squash('pub enum ShowPetByIdError { Status404(models::Error), Status4xx(String), }'));
    expect(svc).toContain(
      squash(`impl core::ErrorBody for ShowPetByIdError {
        fn decode(status: u16, body: &[u8]) -> Option<Self> {
            match status {
                404 => core::decode_error_json(body).map(Self::Status404),
                400..=499 => Some(Self::Status4xx(core::decode_error_text(body))),
                _ => None,
            } } }`),
    );
    expect(svc).toContain(squash('impl core::ErrorBody for ListPetsError { fn decode(_status: u16, body: &[u8]) -> Option<Self> { core::decode_error_json(body).map(Self::Default) } }'));
  });

  it('renames colliding parameters and escapes keywords', async () => {
    const ir = doc({}, [
      operation('GET /items/{id}', 'getItem', {
        parameters: [
          param('id', 'path', str),
          param('id', 'query', str),
          param('type', 'query', str),
          param('send', 'query', str),
          param('options', 'header', str, { required: true }),
        ],
        responses: [response(204)],
      }),
    ]);
    const svc = squash(file((await generate(ir)).files, 'src/services/default.rs'));
    expect(svc).toContain(squash('pub fn get_item(&self, id: impl Into<String>, options2: impl Into<String>) -> GetItemRequest {'));
    expect(svc).toContain(squash('pub fn id2(mut self, value: impl Into<String>) -> Self'));
    expect(svc).toContain(squash('pub fn r#type(mut self, value: impl Into<String>) -> Self'));
    expect(svc).toContain(squash('pub fn send2(mut self, value: impl Into<String>) -> Self'));
    expect(svc).toContain(squash('.query("type", &self.r#type)'));
  });

  it('encodes each body kind', async () => {
    const ir = doc(
      {
        Upload: obj([prop('title', str, true), prop('file', bin, true), prop('extra', bin), prop('files', arr(bin)), prop('tags', arr(str))]),
        Form: obj([prop('name', str, true)]),
        Payload: obj([prop('a', str)]),
      },
      [
        operation('POST /json', 'sendJson', { requestBody: { required: true, contents: [json(ref('Payload'))] }, responses: [response(204)] }),
        operation('POST /optional', 'sendOptional', { requestBody: { required: false, contents: [json(ref('Payload'))] }, responses: [response(204)] }),
        operation('POST /upload', 'upload', {
          requestBody: { required: true, contents: [{ mediaType: 'multipart/form-data', kind: 'multipart', schema: ref('Upload') }] },
          responses: [response(204)],
        }),
        operation('POST /form', 'sendForm', {
          requestBody: { required: true, contents: [{ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: ref('Form') }] },
          responses: [response(204)],
        }),
        operation('POST /raw-form', 'sendRawForm', {
          requestBody: { required: true, contents: [{ mediaType: 'application/x-www-form-urlencoded', kind: 'form', schema: { kind: 'unknown', nullable: false } }] },
          responses: [response(204)],
        }),
        operation('POST /text', 'sendText', { requestBody: { required: true, contents: [text] }, responses: [response(204)] }),
        operation('POST /binary', 'sendBinary', {
          requestBody: { required: true, contents: [{ mediaType: 'application/octet-stream', kind: 'binary', schema: bin }] },
          responses: [response(204)],
        }),
        operation('GET /ignored', 'getIgnored', { requestBody: { required: true, contents: [json(str)] }, responses: [response(204)] }),
      ],
    );
    const { files, diagnostics } = await generate(ir);
    const svc = squash(file(files, 'src/services/default.rs'));
    expect(svc).toContain(squash('pub fn send_json(&self, body: impl Into<models::Payload>) -> SendJsonRequest'));
    expect(svc).toContain(squash('.json_body(&self.body);'));
    expect(svc).toContain(squash('let mut values = core::RequestValues::new(); if let Some(body) = self.body { values = values.json_body(&body); }'));
    expect(svc).toContain(
      squash(`.multipart(
        core::MultipartBody::new()
            .add_json("title", &self.body.title)
            .add_file("file", &self.body.file)
            .add_file("extra", self.body.extra.as_ref())
            .add_files("files", self.body.files.iter().flatten())
            .add_json("tags", &self.body.tags),
      );`),
    );
    expect(svc).toContain('.form_body(&self.body);');
    expect(svc).toContain(squash('pub fn send_raw_form(&self, body: impl Into<core::FormBody>) -> SendRawFormRequest'));
    expect(svc).toContain('.form(self.body);');
    expect(svc).toContain('.text_body(self.body);');
    expect(svc).toContain(squash('pub fn send_binary(&self, body: impl Into<crate::core::ApiFile>) -> SendBinaryRequest'));
    expect(svc).toContain('.binary_body(self.body);');
    expect(svc).toContain(squash('pub fn get_ignored(&self) -> GetIgnoredRequest'));
    expect(diagnostics.entries.map((d) => d.code)).toContain('request-body-ignored');
  });

  it('honours include / exclude and the method naming rules', async () => {
    const { files, api } = await generate(petstore(), { exclude: ['DELETE /pets/{petId}'], naming: { method: { name: 'do_{{name}}' } } });
    const svc = pets(files);
    expect(svc).toContain('pub fn do_list_pets(');
    expect(svc).not.toContain('delete_pet');
    expect(api.symbols.operation('GET /pets')).toEqual({
      service: 'PetsService',
      accessor: 'pets',
      method: 'do_list_pets',
      builder: 'ListPetsRequest',
      error: 'ListPetsError',
      module: 'crate::services::pets',
      file: 'src/services/pets.rs',
    });
    expect(() => api.symbols.operation('DELETE /pets/{petId}')).toThrow(/excluded/);
    const hooked = pets((await generate(petstore(), { hooks: { methodName: (op) => (op.name === 'listPets' ? 'all' : undefined) } })).files);
    expect(hooked).toContain('pub fn all(');
  });

  it('lists the services in services/mod.rs', async () => {
    expect(file((await generate(petstore())).files, 'src/services/mod.rs')).toContain(
      'pub mod pets;\npub mod default;\n\npub use self::pets::PetsService;\npub use self::default::DefaultService;\n',
    );
  });
});
