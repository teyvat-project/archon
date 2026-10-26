# frozen_string_literal: true

module Archon::Core
  # The standard middleware. A middleware is any object responding to `call(request, context, next_)` that returns
  # the Response of `next_.call(request)` (or its own).
  module Middleware
    MASK = '***'
    DEFAULT_REDACT_HEADERS = %w[Authorization Cookie Proxy-Authorization Set-Cookie].freeze

    # Logs `→ METHOD url` (optionally with the request headers, one line each, by name) and `← status (ms)`.
    # Credentials are masked as ***: Authorization, Cookie, Proxy-Authorization, Set-Cookie, the API key headers and
    # query parameters of the spec, and the names in `redact_headers` / `redact_query`. `logger` is a Logger
    # (lines go to #info), a callable taking each line, or nil for $stderr.
    class Logging
      def initialize(logger: nil, include_headers: false, redact_headers: [], redact_query: [], clock: nil)
        @logger = logger
        @include_headers = include_headers
        @redact_headers = redact_headers
        @redact_query = redact_query
        @clock = clock || -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) }
      end

      def call(request, context, next_)
        headers = [*DEFAULT_REDACT_HEADERS, *context.redact_headers, *@redact_headers].map(&:downcase)
        query = [*context.redact_query, *@redact_query].map(&:downcase)
        log("→ #{request.http_method} #{Logging.masked_url(request.url, query)}")
        if @include_headers
          request.headers.names.sort_by(&:downcase).each do |name|
            request.headers.values(name).each do |value|
              log("  #{name}: #{headers.include?(name.downcase) ? MASK : value}")
            end
          end
        end
        started = @clock.call
        response = next_.call(request)
        log("← #{response.status} (#{((@clock.call - started) * 1000).floor}ms)")
        response
      end

      # The URL for display, without its fragment and with the values of the given (lower-cased) query names masked.
      def self.masked_url(url, redact_query)
        parts = Url.split(url)
        parts.fragment = nil
        if parts.query
          parts.query = parts.query.split('&', -1).map do |pair|
            eq = pair.index('=')
            eq && redact_query.include?(Url.decode_name(pair).downcase) ? "#{pair[0, eq]}=#{MASK}" : pair
          end.join('&')
        end
        parts.to_s
      end

      private

      def log(line)
        if @logger.nil? then $stderr.puts(line)
        elsif @logger.respond_to?(:info) then @logger.info(line)
        else @logger.call(line)
        end
      end
    end

    # Sets the User-Agent header.
    class UserAgent
      def initialize(value)
        @value = value
      end

      def call(request, _context, next_)
        request.headers['User-Agent'] = @value
        next_.call(request)
      end
    end

    # Retries idempotent, replayable requests on the configured statuses and on network errors (not on timeouts),
    # with exponential backoff and equal jitter: min(max_delay, base_delay * 2^(attempt-1)) * (0.5 + random/2).
    # Retry-After on 429 / 503 is honoured, capped by `max_retry_after`. Delays are in seconds.
    class Retry
      DEFAULT_STATUSES = [408, 429, 500, 502, 503, 504].freeze
      DEFAULT_METHODS = %w[GET HEAD OPTIONS PUT DELETE].freeze

      def initialize(max_attempts: 3, base_delay: 0.2, max_delay: 5.0, max_retry_after: 60.0, statuses: DEFAULT_STATUSES,
                     methods: DEFAULT_METHODS, retry_network_errors: true, sleep: nil, random: nil, now: nil)
        @max_attempts = max_attempts
        @base_delay = base_delay
        @max_delay = max_delay
        @max_retry_after = max_retry_after
        @statuses = statuses
        @methods = methods
        @retry_network_errors = retry_network_errors
        @sleep = sleep || ->(seconds) { Kernel.sleep(seconds) if seconds.positive? }
        @random = random || -> { Kernel.rand }
        @now = now || -> { Time.now }
      end

      def call(request, context, next_)
        retryable = request.replayable? && @methods.include?(request.http_method)
        attempt = 1
        loop do
          can_retry = retryable && attempt < @max_attempts
          begin
            response = next_.call(request)
          rescue TransportError => e
            raise if !can_retry || !@retry_network_errors || e.timeout?

            delay = backoff(attempt)
          else
            return response if !can_retry || !@statuses.include?(response.status)

            delay = backoff(attempt)
            if [429, 503].include?(response.status)
              after = retry_after(response.headers['Retry-After'])
              delay = [after, @max_retry_after].min if after
            end
          end
          @sleep.call(delay)
          context.attempt += 1
          attempt += 1
        end
      end

      private

      def backoff(attempt)
        [@max_delay, @base_delay * (2**(attempt - 1))].min * (0.5 + (@random.call / 2))
      end

      # Seconds or an HTTP-date.
      def retry_after(value)
        value = value.to_s.strip
        return nil if value.empty?
        return value.to_i if value.match?(/\A\d+\z/)

        [Time.httpdate(value) - @now.call, 0].max
      rescue ArgumentError
        nil
      end
    end

    # Re-sends once after a 401 when the callback (a block or a callable taking the CallContext and the Response)
    # returns true, e.g. after rotating a static token. Managed OAuth2 tokens already refresh once on 401 inside the
    # authentication layer, so the callback should return false for those schemes.
    class Retry401
      def initialize(on_unauthorized = nil, &block)
        @on_unauthorized = on_unauthorized || block
        raise ArgumentError, 'Retry401 needs a callback' unless @on_unauthorized.respond_to?(:call)
      end

      def call(request, context, next_)
        response = next_.call(request)
        return response unless response.status == 401 && request.replayable? && @on_unauthorized.call(context, response)

        context.attempt += 1
        next_.call(request)
      end
    end
  end
end
