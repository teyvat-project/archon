# frozen_string_literal: true

module Archon::Core
  # Builds, sends and decodes operation calls for a generated client. It is safe to use from several threads.
  #
  # - `base_url` is absolute; its path is kept (https://x.test/api/ + /foo → https://x.test/api/foo).
  # - `auth` holds the credentials per security scheme (the generated Auth, or a Hash keyed by scheme name).
  # - `headers` are sent with every request.
  # - `timeout` (seconds) is the time allowed until the final response arrives, redirects included; nil waits
  #   indefinitely.
  # - `middleware` are objects responding to `call(request, context, next_)`, outermost first.
  # - `transport` sends one request (see NetHttpTransport); it is also used for OAuth2 token requests.
  # - `custom_auth` is called with the request and the CallContext last when applying authentication; it also
  #   satisfies schemes the generator could not model.
  class Client
    EMPTY = [0, 204, 205, 304].freeze
    private_constant :EMPTY

    attr_reader :base_url, :security_schemes, :auth, :headers, :timeout, :transport, :custom_auth

    def initialize(base_url:, security_schemes: {}, auth: nil, headers: {}, timeout: nil, middleware: [], transport: nil, custom_auth: nil)
      @base_url = base_url
      @security_schemes = security_schemes
      @auth = auth
      @headers = headers
      @timeout = timeout
      @transport = transport || NetHttpTransport.new
      @custom_auth = custom_auth
      @mutex = Mutex.new
      @middleware = []
      Array(middleware).each { |m| use(m) }
      api_keys = security_schemes.sort_by(&:first).map(&:last).select { |s| s.kind == :api_key }
      @credential_headers = api_keys.select { |s| s.location == :header }.map(&:name).freeze
      @credential_query = api_keys.select { |s| s.location == :query }.map(&:name).freeze
      @auth_layer = AuthLayer.new(self)
    end

    # Appends a middleware (inside those already registered, outside authentication): an object responding to
    # `call(request, context, next_)`, or a block taking the same arguments.
    def use(middleware = nil, &block)
      layer = middleware || block
      raise ArgumentError, 'a middleware must respond to call(request, context, next_)' unless layer.respond_to?(:call)

      @mutex.synchronize { @middleware << layer }
      self
    end

    # Sends one operation call and returns the decoded 2xx body (nil for no content). The block, if given, receives
    # the successful Response. Raises ApiError for a non-2xx response, TransportError, DecodeError and AuthError.
    def call(operation, values = nil, request_options = nil, &on_response)
      options = RequestOptions.coerce(request_options)
      request = build_request(operation, values || Values.new, options)
      context = CallContext.new(
        operation_name: operation.name,
        http_method: operation.http_method,
        path_template: operation.path,
        tags: operation.tags,
        security: operation.security,
        redact_headers: @credential_headers,
        redact_query: @credential_query,
        extensions: options.extensions.dup,
      )
      chain = @mutex.synchronize { @middleware.dup } << @auth_layer
      terminal = lambda do |req|
        Redirects.follow(@transport, req, timeout: @timeout, credential_headers: @credential_headers, credential_query: @credential_query)
      end
      response = chain.reverse.reduce(terminal) { |inner, layer| ->(req) { layer.call(req, context, inner) } }.call(request)
      raise Error, 'the middleware chain returned no Response' unless response.is_a?(Response)
      raise api_error(operation, response) unless response.success?

      on_response&.call(response)
      decode(operation, response)
    end

    private

    def build_request(operation, values, options)
      path = Params.path(operation.path, operation.params, values)
      base, base_query = (options.base_url || @base_url).to_s.split('?', 2)
      queries = [base_query, Params.query(operation.params, values)].reject { |q| q.nil? || q.empty? }
      url = "#{base.to_s.sub(%r{/+\z}, '')}/#{path.sub(%r{\A/+}, '')}"
      url += "?#{queries.join('&')}" unless queries.empty?
      Url.require_absolute!(url)

      headers = Headers.new(@headers)
      operation.params.each do |spec|
        next unless spec.location == :header && values.key?(:header, spec.name)

        text = Params.header(spec, values.get(:header, spec.name))
        headers[spec.name] = text unless text.nil?
      end
      overrides = Headers.new(options.headers)
      overrides.names.each { |name| headers[name] = overrides.values(name) }
      cookie = Params.cookie(operation.params, values)
      headers['Cookie'] = headers.key?('Cookie') ? "#{headers['Cookie']}; #{cookie}" : cookie unless cookie.empty?

      body = operation.body && values.body_for(operation.media_type)
      if body
        if body.content_type.nil?
          headers.delete('Content-Type')
        elsif !overrides.key?('Content-Type')
          headers['Content-Type'] = body.content_type
        end
      end
      unless headers.key?('Accept')
        json = operation.success == :json || operation.errors.values.any? { |e| e.is_a?(Types::Type) }
        headers['Accept'] = json ? 'application/json' : '*/*'
      end
      Request.new(http_method: operation.http_method, url: url, headers: headers, body: body)
    end

    def empty?(response) = EMPTY.include?(response.status) || response.body.empty?

    def decode(operation, response)
      case operation.success
      when :json
        return nil if empty?(response)

        json = Json.parse(response.text)
        operation.result ? operation.result.decode(json, '$') : json
      when :text then response.text
      when :binary then response.body
      end
    rescue DecodeError => e
      raise DecodeError.new("failed to decode the response (HTTP #{response.status}): #{e.message}", status: response.status, raw_body: response.body)
    end

    # The error for a non-2xx response; a JSON error body that is empty or not the declared type leaves `body` nil.
    def api_error(operation, response)
      status = response.status.to_s
      lookup = ->(key) { operation.errors.find { |k, _| k.to_s.casecmp?(key) }&.last }
      type = lookup.(status) || lookup.("#{status[0]}XX") || lookup.('default')
      return ApiError.new(response) if type.nil?
      return ApiError.new(response, body: response.text) if type == :text
      return ApiError.new(response) if response.body.empty?

      ApiError.new(response, body: type.decode(Json.parse(response.text), '$'))
    rescue DecodeError => e
      ApiError.new(response, decode_error: e)
    end
  end
end
