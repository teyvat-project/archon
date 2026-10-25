import { resolveConfig } from '../../../src/config/resolve.js';
import { Diagnostics } from '../../../src/diagnostics.js';
import type {
  IRDocument,
  IRMediaType,
  IROperation,
  IRParameter,
  IRProperty,
  IRResponse,
  IRSchema,
} from '../../../src/ir/types.js';
import { runPluginPasses } from '../../../src/passes/index.js';
import type { DeepPartial } from '../../../src/plugin/define.js';
import type { EmittedFile, PluginContext } from '../../../src/plugin/types.js';
import { typescript } from '../../../src/plugins.js';
import type { TypeScriptPluginAPI, TypeScriptPluginOptions } from '../../../src/plugins/typescript/index.js';
import { CodeWriter } from '../../../src/writer/code-writer.js';

// ---- IR builders ----
export const str: IRSchema = { kind: 'string', nullable: false };
export const int: IRSchema = { kind: 'integer', nullable: false };
export const bin: IRSchema = { kind: 'binary', nullable: false };
export const dateTime: IRSchema = { kind: 'string', format: 'date-time', nullable: false };
export const date: IRSchema = { kind: 'string', format: 'date', nullable: false };
export const ref = (name: string): IRSchema => ({ kind: 'ref', name, nullable: false });
export const arr = (items: IRSchema): IRSchema => ({ kind: 'array', items, nullable: false });
export const prop = (name: string, schema: IRSchema, required = false): IRProperty => ({ name, schema, required });
export const obj = (properties: IRProperty[], extra: Partial<Extract<IRSchema, { kind: 'object' }>> = {}): IRSchema => ({
  kind: 'object',
  nullable: false,
  properties,
  ...extra,
});

export const param = (
  name: string,
  where: IRParameter['in'],
  schema: IRSchema,
  extra: Partial<IRParameter> = {},
): IRParameter => ({
  name,
  in: where,
  required: where === 'path',
  deprecated: false,
  schema,
  style: where === 'query' || where === 'cookie' ? 'form' : 'simple',
  explode: where === 'query' || where === 'cookie',
  allowReserved: false,
  ...extra,
});

export const json = (schema: IRSchema): IRMediaType => ({ mediaType: 'application/json', kind: 'json', schema });

export const response = (status: IRResponse['status'], contents: IRMediaType[] = []): IRResponse => ({
  status,
  headers: new Map(),
  contents,
});

export function operation(id: string, name: string, extra: Partial<IROperation> = {}): IROperation {
  const [method, path] = id.split(' ') as [string, string];
  return {
    id,
    name,
    method: method.toLowerCase() as IROperation['method'],
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    ...extra,
  };
}

/** petstore 相当の小さな IR。 */
export function petstore(): IRDocument {
  return {
    info: { title: 'Pet Store API', version: '1.2.3' },
    servers: [{ url: 'https://petstore.test/v1', variables: {} }],
    securitySchemes: new Map([['bearerAuth', { kind: 'http-bearer' }]]),
    schemas: new Map<string, IRSchema>([
      ['Error', obj([prop('code', int, true), prop('message', str, true)])],
      ['NewPet', obj([prop('name', str, true), prop('tag', str)])],
      ['Pet', obj([prop('id', int, true), prop('name', str, true), prop('tag', str), prop('createdAt', dateTime)])],
    ]),
    operations: [
      operation('GET /health', 'getHealth', {
        responses: [response(200, [{ mediaType: 'text/plain', kind: 'text', schema: str }])],
      }),
      operation('GET /pets', 'listPets', {
        tags: ['pets'],
        group: 'pets',
        parameters: [param('limit', 'query', int), param('x-trace', 'header', str)],
        responses: [response(200, [json(arr(ref('Pet')))]), response('default', [json(ref('Error'))])],
      }),
      operation('POST /pets', 'createPet', {
        tags: ['pets'],
        group: 'pets',
        requestBody: { required: true, contents: [json(ref('NewPet'))] },
        responses: [response(201, [json(ref('Pet'))]), response('default', [json(ref('Error'))])],
        security: [{ schemes: [{ name: 'bearerAuth', scopes: [] }] }],
      }),
      operation('GET /pets/{petId}', 'showPetById', {
        tags: ['pets'],
        group: 'pets',
        summary: 'Info for a specific pet',
        description: 'Returns a single pet.',
        deprecated: true,
        parameters: [param('petId', 'path', str)],
        responses: [
          response(200, [json(ref('Pet'))]),
          response(404, [json(ref('Error'))]),
          response('default', [json(ref('Error'))]),
        ],
        security: [{ schemes: [{ name: 'bearerAuth', scopes: ['read'] }] }, { schemes: [] }],
      }),
      operation('POST /pets/{petId}/photo', 'uploadPhoto', {
        tags: ['pets'],
        group: 'pets',
        parameters: [param('petId', 'path', str)],
        requestBody: {
          required: false,
          contents: [
            {
              mediaType: 'multipart/form-data',
              kind: 'multipart',
              schema: obj([prop('file', bin, true), prop('caption', str)]),
            },
          ],
        },
        responses: [response(204)],
      }),
    ],
  };
}

export function options(opts: DeepPartial<TypeScriptPluginOptions> = {}): TypeScriptPluginOptions {
  return typescript(opts).options;
}

export function fakeCtx(
  ir: IRDocument,
  opts: TypeScriptPluginOptions,
  emitted: EmittedFile[] = [],
  header: string[] = ['Generated header'],
): PluginContext<TypeScriptPluginOptions> {
  return {
    ir,
    options: opts,
    config: resolveConfig({ input: 'spec.yaml', output: 'out' }, { cwd: '/proj' }),
    outputDir: 'typescript',
    diagnostics: new Diagnostics(),
    emit: (path, content) => void emitted.push({ path, content }),
    headerLines: () => header,
    writer: (o) => new CodeWriter(o),
    plugin: () => {
      throw new Error('no dependencies');
    },
  };
}

/** プラグインの generate を実行し、出力ファイルをパス → 内容の Map で返す。 */
export async function generate(ir: IRDocument, opts: DeepPartial<TypeScriptPluginOptions> = {}) {
  const plugin = typescript(opts);
  const emitted: EmittedFile[] = [];
  const pluginIR = runPluginPasses(ir, plugin.definition.irRequirements?.(plugin.options) ?? {});
  const ctx = fakeCtx(pluginIR, plugin.options, emitted);
  const api = (await plugin.definition.generate(ctx)) as TypeScriptPluginAPI;
  const files = new Map(emitted.map((f) => [f.path, String(f.content)]));
  return { api, emitted, files, diagnostics: ctx.diagnostics };
}

/** 出力ファイルの内容（無ければテストを失敗させる）。 */
export function file(files: Map<string, string>, path: string): string {
  const content = files.get(path);
  if (content === undefined) throw new Error(`"${path}" was not emitted (got: ${[...files.keys()].join(', ')})`);
  return content;
}
