# frozen_string_literal: true

module Archon::Core
  # The base class of every error the SDK raises.
  class Error < StandardError
  end

  # A non-2xx response. `body` is the body decoded as the type declared for its status (such as a NotFoundError
  # model), or nil when there is none or it could not be decoded (`decode_error` then says why).
  class ApiError < Error
    attr_reader :response, :body, :decode_error

    def initialize(response, body: nil, decode_error: nil)
      @response = response
      @body = body
      @decode_error = decode_error
      message = "HTTP #{response.status}"
      message += " (the error body is not the declared JSON: #{decode_error.message})" if decode_error
      super(message)
    end

    def status = response.status
    def headers = response.headers
    def raw_body = response.body
    # The final request URL.
    def url = response.url
  end

  # The request could not be sent or the response could not be read (network failure, timeout). `cause` is the
  # underlying exception, when there is one.
  class TransportError < Error
    def timeout? = false
  end

  # The client's timeout elapsed before the final response arrived.
  class TimeoutError < TransportError
    def timeout? = true
  end

  # A response body (or a JSON value given to `from_json`) could not be decoded. `status` and `raw_body` are set
  # for responses.
  class DecodeError < Error
    attr_reader :status, :raw_body

    def initialize(message, status: nil, raw_body: nil)
      @status = status
      @raw_body = raw_body
      super(message)
    end
  end

  # Required credentials are not configured (raised before the request is sent), or a token request failed.
  class AuthError < Error
    attr_reader :schemes

    def initialize(message, schemes: [])
      @schemes = schemes
      super(message)
    end

    def self.missing(schemes)
      new("missing credentials for security scheme(s): #{schemes.join(', ')}", schemes: schemes)
    end
  end
end
