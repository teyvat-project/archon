# frozen_string_literal: true

module Archon::Core
  # How one operation parameter is serialized. `location` is :path, :query, :header or :cookie; `style` is :simple,
  # :label, :matrix, :form, :space_delimited, :pipe_delimited or :deep_object.
  ParamSpec = Data.define(:name, :location, :style, :explode, :allow_reserved)

  class ParamSpec
    def initialize(name:, location:, style:, explode: false, allow_reserved: false)
      super
    end
  end

  # A security scheme of the API. `kind` is :http_bearer, :http_basic, :api_key, :oauth2 or :open_id_connect;
  # `location` (:header, :query, :cookie) and `name` are those of an API key; `token_url` and `refresh_url` are the
  # spec's OAuth2 defaults (relative ones resolve against the base URL).
  SecuritySchemeSpec = Data.define(:kind, :location, :name, :token_url, :refresh_url)

  class SecuritySchemeSpec
    def initialize(kind:, location: nil, name: nil, token_url: nil, refresh_url: nil)
      super
    end
  end

  # Everything the runtime needs to know about one operation.
  #
  # - `security` is the OR-of-AND requirements: `[{ 'oauth2' => ['read'] }, {}]` (an empty Hash means the operation
  #   also accepts no authentication; an empty Array that it needs none).
  # - `body` is the request body encoding (:json, :form, :multipart, :text, :binary or nil) and `media_type` its
  #   media type.
  # - `success` is the content kind of the lowest 2xx response (:json, :text, :binary or nil) and `result` the type
  #   its JSON decodes as.
  # - `errors` maps status keys ("404", "4XX", "default") to the type of their JSON body, or :text.
  Operation = Data.define(:name, :http_method, :path, :tags, :security, :params, :body, :media_type, :success, :result, :errors)

  class Operation
    def initialize(name:, http_method:, path:, tags: [], security: [], params: [], body: nil, media_type: nil, success: nil,
                   result: nil, errors: {})
      super
    end
  end
end
