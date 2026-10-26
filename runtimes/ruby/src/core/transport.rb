# frozen_string_literal: true

module Archon::Core
  # The default transport: one Net::HTTP exchange per call (a new connection each time, so it is safe to share
  # between threads). It does not follow redirects; the client does. `configure` receives each Net::HTTP before it
  # starts (client certificates, CA files, proxies, ...).
  #
  # A transport is anything responding to `call(request, timeout:)` that sends one Request and returns a Response
  # (`timeout` is the time left in seconds, or nil); it raises TransportError (TimeoutError for timeouts).
  class NetHttpTransport
    NETWORK_ERRORS = [SocketError, SystemCallError, IOError, Net::ProtocolError].freeze
    private_constant :NETWORK_ERRORS

    def initialize(configure: nil)
      @configure = configure
    end

    def call(request, timeout: nil)
      parts = Url.split(request.url)
      http = connection(parts, timeout)
      content, length = request.body&.open
      target = parts.path.empty? ? '/' : parts.path
      target += "?#{parts.query}" if parts.query
      net = Net::HTTPGenericRequest.new(request.http_method, !content.nil?, request.http_method != 'HEAD', target)
      # Net::HTTP's defaults (Accept, User-Agent, Accept-Encoding) give way to the request's headers.
      request.headers.names.each { |name| net.delete(name) }
      request.headers.each { |name, value| net.add_field(name, value) }
      if content.is_a?(String)
        net.body = content
      elsif content
        net.body_stream = content
        if length
          net.content_length = length
        else
          net['Transfer-Encoding'] = 'chunked'
        end
      end
      response = http.start { |h| h.request(net) }
      headers = Headers.new
      response.each_header { |name, _| response.get_fields(name).each { |value| headers.add(name, value) } }
      Response.new(status: response.code.to_i, headers: headers, body: response.body.to_s, url: request.url)
    rescue Timeout::Error => e
      raise TimeoutError, "no response within #{timeout}s (#{e.class})"
    rescue *network_errors => e
      raise TransportError, "request failed: #{e.message} (#{e.class})"
    end

    private

    def connection(parts, timeout)
      authority = parts.authority.to_s.split('@').last.to_s
      host, port = /\A(\[[^\]]*\]|[^:]*)(?::(\d*))?\z/.match(authority)&.captures
      https = parts.scheme.to_s.downcase == 'https'
      port = port.nil? || port.empty? ? (https ? 443 : 80) : port.to_i
      http = Net::HTTP.new(host.to_s.delete_prefix('[').delete_suffix(']'), port)
      http.use_ssl = https
      if timeout
        http.open_timeout = timeout
        http.read_timeout = timeout
        http.write_timeout = timeout
        http.ssl_timeout = timeout
      end
      @configure&.call(http)
      http
    end

    def network_errors
      defined?(OpenSSL::SSL::SSLError) ? [*NETWORK_ERRORS, OpenSSL::SSL::SSLError] : NETWORK_ERRORS
    end
  end

  # Sends requests through a transport, following redirects by hand so credentials are dropped when the origin
  # changes (spec §8.5). The timeout covers everything up to the final response (redirects included).
  module Redirects
    MAX = 20
    BODY_HEADERS = %w[Content-Encoding Content-Language Content-Location Content-Type Content-Length].freeze

    module_function

    def follow(transport, request, timeout:, credential_headers: [], credential_query: [])
      deadline = timeout && (now + timeout)
      http_method = request.http_method
      url = request.url
      headers = request.headers.dup
      body = request.body
      redirects = 0
      loop do
        remaining = deadline && (deadline - now)
        raise TimeoutError, "no response within #{timeout}s" if remaining && remaining <= 0

        response = transport.call(Request.new(http_method: http_method, url: url, headers: headers.dup, body: body), timeout: remaining)
        raise TimeoutError, "no response within #{timeout}s" if deadline && now > deadline

        status = response.status
        location = response.headers['Location']
        # 303 (except HEAD) and 301/302 on POST switch to a bodiless GET; everything else re-sends the body.
        to_get = (status == 303 && http_method != 'HEAD') || ([301, 302].include?(status) && http_method == 'POST')
        redirect = [301, 302, 303, 307, 308].include?(status)
        return response if !redirect || location.nil? || location.empty? || (!to_get && body && !body.replayable?)
        raise TransportError, "too many redirects (more than #{MAX})" if redirects >= MAX

        redirects += 1
        target = Url.resolve(url, location)
        if Url.origin(target) != Url.origin(url)
          ['Authorization', 'Cookie', *credential_headers].each { |name| headers.delete(name) }
          target = Url.without_query(target, credential_query)
        end
        if to_get
          http_method = 'GET'
          body = nil
          BODY_HEADERS.each { |name| headers.delete(name) }
        end
        url = target
      end
    end

    def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
