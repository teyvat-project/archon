export interface IRDocument {
  info: { title: string; version: string; description?: string };
  servers: IRServer[];
  securitySchemes: Map<string, IRSecurityScheme>;
  /** 名前付き schema（巻き上げ後のものを含む） */
  schemas: Map<string, IRSchema>;
  operations: IROperation[];
}

export type IRServer = {
  url: string;
  description?: string;
  variables: Record<string, { default: string; enum?: string[] }>;
};

export type IROAuthFlow = {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
};

export type IROAuthFlows = {
  clientCredentials?: IROAuthFlow;
  authorizationCode?: IROAuthFlow;
  implicit?: IROAuthFlow;
  password?: IROAuthFlow;
};

export type IRSecurityScheme =
  | { kind: 'http-bearer'; bearerFormat?: string }
  | { kind: 'http-basic' }
  | { kind: 'http-other'; scheme: string } // 未対応 → 警告
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2'; flows: IROAuthFlows }
  | { kind: 'openIdConnect'; url: string }
  | { kind: 'mutualTLS' }; // 未対応 → 警告

/** schemes: [] は `{}`（任意認証）を表す。 */
export type IRSecurityRequirement = { schemes: { name: string; scopes: string[] }[] };

export type IRSchema = IRSchemaBase &
  (
    | { kind: 'string'; format?: string; pattern?: string; minLength?: number; maxLength?: number }
    | { kind: 'integer'; format?: 'int32' | 'int64' }
    | { kind: 'number'; format?: 'float' | 'double' }
    | { kind: 'boolean' }
    | { kind: 'null' }
    | { kind: 'array'; items: IRSchema; uniqueItems?: boolean }
    | { kind: 'tuple'; items: IRSchema[]; rest?: IRSchema }
    | { kind: 'object'; properties: IRProperty[]; additionalProperties?: IRSchema | false }
    | { kind: 'enum'; base: 'string' | 'integer' | 'number'; values: (string | number)[] }
    | { kind: 'const'; value: unknown }
    | {
        kind: 'union';
        variants: IRSchema[];
        discriminator?: { property: string; mapping: Map<string, string> };
      }
    | { kind: 'intersection'; members: IRSchema[] }
    | { kind: 'ref'; name: string }
    | { kind: 'binary' }
    | { kind: 'unknown' }
  );

export interface IRSchemaBase {
  nullable: boolean;
  title?: string;
  description?: string;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
  readOnly?: boolean;
  writeOnly?: boolean;
  /** 元の JSON Pointer（ログと命名に使う） */
  origin?: string;
}

export interface IRProperty {
  name: string;
  schema: IRSchema;
  required: boolean;
}

export interface IROperation {
  /** "GET /catalyst/v1/status/{id}" */
  id: string;
  /** operationId もしくは導出名 */
  name: string;
  /** サービス分割キー（既定: 先頭 tag） */
  group?: string;
  method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;
  /** path-level と operation-level をマージ済み */
  parameters: IRParameter[];
  requestBody?: { required: boolean; contents: IRMediaType[] };
  /** status: number | '1XX'..'5XX' | 'default' */
  responses: IRResponse[];
  /** OR-of-AND。[] は認証なし、schemes: [] の要素を含めば任意 */
  security: IRSecurityRequirement[];
  servers?: IRServer[];
}

export interface IRParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  deprecated: boolean;
  schema: IRSchema;
  style: 'simple' | 'label' | 'matrix' | 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';
  explode: boolean;
  allowReserved: boolean;
}

export interface IRMediaType {
  mediaType: string;
  kind: 'json' | 'form' | 'multipart' | 'text' | 'binary';
  schema: IRSchema;
  encoding?: Map<string, { contentType?: string; style?: string; explode?: boolean }>;
}

export interface IRResponse {
  status: number | string;
  description?: string;
  headers: Map<string, IRSchema>;
  contents: IRMediaType[];
}
