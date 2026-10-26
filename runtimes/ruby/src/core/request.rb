# frozen_string_literal: true

module Archon::Core
  # One HTTP request travelling through the middleware chain. `url` is absolute and sent byte for byte (it is
  # never re-encoded).
  class Request
    attr_accessor :http_method, :url, :body
    attr_reader :headers

    def initialize(http_method:, url:, headers: Headers.new, body: nil)
      @http_method = http_method
      @url = url
      @headers = headers.is_a?(Headers) ? headers : Headers.new(headers)
      @body = body
    end

    # Whether the request can be sent again (buffered bodies can, streamed ones cannot).
    def replayable? = body.nil? || body.replayable?

    # Sets a query parameter, replacing any with the same name and leaving the other parameters' bytes untouched.
    def set_query_parameter(name, value)
      parts = Url.split(url)
      pairs = Url.query_pairs(parts.query).reject { |pair| Url.decode_name(pair) == name }
      pairs << "#{Percent.component(name)}=#{Percent.component(value)}"
      parts.query = pairs.join('&')
      parts.fragment = nil
      self.url = parts.to_s
    end

    def initialize_copy(other)
      super
      @headers = other.headers.dup
    end
  end

  # A received response; `body` has been read completely (a binary String) and `url` is the final request URL
  # (after redirects).
  class Response
    attr_reader :status, :headers, :body, :url

    def initialize(status:, headers: Headers.new, body: '', url: nil)
      @status = status
      @headers = headers.is_a?(Headers) ? headers : Headers.new(headers)
      @body = body.to_s.b
      @url = url
    end

    def success? = status >= 200 && status <= 299

    # The body as UTF-8 text.
    def text = Json.utf8(body)
  end

  # What the middleware chain knows about the call in flight. `attempt` is 1 for the first send and retrying
  # middleware increments it; `redact_headers` / `redact_query` name (case-insensitively) the headers and query
  # parameters carrying credentials, to mask in logs; `extensions` are arbitrary per-call values.
  class CallContext
    attr_reader :operation_name, :http_method, :path_template, :tags, :security, :redact_headers, :redact_query, :extensions
    attr_accessor :attempt

    def initialize(operation_name:, http_method:, path_template:, tags: [], security: [], redact_headers: [], redact_query: [],
                   extensions: {}, attempt: 1)
      @operation_name = operation_name
      @http_method = http_method
      @path_template = path_template
      @tags = tags
      @security = security
      @redact_headers = redact_headers
      @redact_query = redact_query
      @extensions = extensions
      @attempt = attempt
    end
  end

  # Per-call settings: extra `headers` (overriding client headers with the same name), a `base_url` override, and
  # `extensions` handed to middleware through CallContext#extensions. Operations also take them as a Hash.
  RequestOptions = Data.define(:headers, :base_url, :extensions)

  class RequestOptions
    def initialize(headers: {}, base_url: nil, extensions: {})
      super
    end

    def self.coerce(value)
      case value
      when nil then new
      when RequestOptions then value
      when Hash then new(**value.transform_keys(&:to_sym))
      else raise ArgumentError, "request_options must be a Hash or a RequestOptions, got #{value.class}"
      end
    end
  end
end
