# frozen_string_literal: true

module Archon::Core
  # A token response; a nil `expires_at` means the token does not expire.
  TokenSet = Data.define(:access_token, :refresh_token, :expires_at, :scope)

  # Obtains and caches OAuth2 access tokens through the client credentials or refresh token grant. Tokens are
  # renewed `leeway` seconds before they expire; concurrent requests for the same scopes share one token request
  # (the first caller fetches, the others wait for it).
  class TokenManager
    InFlight = Struct.new(:done, :tokens, :error)
    private_constant :InFlight

    # `token_url` is the spec's token URL, used when the grant configures none; relative token URLs resolve against
    # `base_url`. `timeout` bounds each token request.
    def initialize(config:, token_url:, base_url:, scheme:, transport: NetHttpTransport.new, timeout: nil, now: nil, leeway: 30)
      @config = config
      @token_url = token_url
      @base_url = base_url
      @schemes = [scheme]
      @transport = transport
      @timeout = timeout
      @now = now || -> { Time.now }
      @leeway = leeway
      @mutex = Mutex.new
      @changed = ConditionVariable.new
      @cache = {}
      @inflight = {}
      @refresh_token = config.refresh_token&.refresh_token
    end

    # A cached token for the scopes, or a new one.
    def token(scopes = [])
      requested = [*scopes, *@config.client_credentials&.scopes].uniq.sort
      key = @config.refresh_token ? '' : requested.join(' ')
      call = nil
      @mutex.synchronize do
        loop do
          cached = @cache[key]
          return cached.access_token if cached && fresh?(cached)

          waiting = @inflight[key]
          break if waiting.nil?

          @changed.wait(@mutex) until waiting.done
          raise waiting.error if waiting.error
          return waiting.tokens.access_token if waiting.tokens
        end
        call = InFlight.new(false, nil, nil)
        @inflight[key] = call
      end

      begin
        tokens = fetch(requested)
        @mutex.synchronize do
          @cache[key] = tokens
          call.tokens = tokens
        end
        tokens.access_token
      rescue StandardError => e
        @mutex.synchronize { call.error = e }
        raise
      ensure
        # Before the waiters wake up, so later callers find the cached token or start a new fetch.
        @mutex.synchronize do
          @inflight.delete(key)
          call.done = true
          @changed.broadcast
        end
      end
    end

    # Drops cached tokens so the next request fetches a new one. With a rejected token only entries holding that
    # token are dropped, so a caller holding a stale token cannot discard a newer one.
    def invalidate(rejected = nil)
      @mutex.synchronize { @cache.delete_if { |_, tokens| rejected.nil? || tokens.access_token == rejected } }
    end

    private

    def fresh?(tokens) = tokens.expires_at.nil? || tokens.expires_at - @leeway > @now.call

    def fail!(message)
      raise AuthError.new(message, schemes: @schemes)
    end

    def fetch(scopes)
      refresh = @config.refresh_token
      credentials = @config.client_credentials
      fail!('the OAuth2 scheme has neither client_credentials nor refresh_token configured') if refresh.nil? && credentials.nil?

      form = FormBody.new
      grant = refresh || credentials
      if refresh
        current = @mutex.synchronize { @refresh_token }
        form.add('grant_type', 'refresh_token').add('refresh_token', current)
      else
        form.add('grant_type', 'client_credentials')
        form.add('scope', scopes.join(' ')) unless scopes.empty?
      end
      configured = grant.token_url || @token_url
      fail!('no token URL is configured for the OAuth2 token request') if configured.nil? || configured.empty?

      headers = Headers.new('Content-Type' => form.content_type, 'Accept' => 'application/json')
      secret = grant.client_secret
      if secret && !secret.empty? && grant.client_auth != :post
        headers['Authorization'] = "Basic #{[Json.utf8("#{grant.client_id}:#{secret}")].pack('m0')}"
      else
        form.add('client_id', grant.client_id)
        form.add('client_secret', secret) if secret && !secret.empty?
      end

      request = Request.new(http_method: 'POST', url: resolve(configured), headers: headers, body: BytesBody.new(form.encode, form.content_type))
      begin
        response = @transport.call(request, timeout: @timeout)
      rescue TransportError => e
        fail!("the token request failed: #{e.message}")
      end
      fail!("the token endpoint responded with HTTP #{response.status}") unless response.success?

      data = begin
        JSON.parse(response.text)
      rescue JSON::ParserError
        nil
      end
      fail!('the token endpoint returned a response that is not a JSON object') unless data.is_a?(Hash)

      access_token = data['access_token']
      fail!('the token endpoint response has no access_token') unless access_token.is_a?(String) && !access_token.empty?

      expires_in = seconds(data['expires_in'])
      rotated = data['refresh_token'].is_a?(String) && !data['refresh_token'].empty? ? data['refresh_token'] : nil
      tokens = TokenSet.new(access_token: access_token, refresh_token: rotated, expires_at: expires_in && (@now.call + expires_in),
                            scope: data['scope'].is_a?(String) ? data['scope'] : nil)
      if rotated && refresh
        @mutex.synchronize { @refresh_token = rotated }
        refresh.on_refreshed&.call(tokens)
      end
      tokens
    end

    # Uses an absolute URL as is and resolves a relative one against the base URL.
    def resolve(url)
      return url if Url.absolute?(url)

      fail!("cannot resolve the relative token URL #{url} without an absolute base URL") unless Url.absolute?(@base_url)
      Url.resolve(@base_url, url)
    end

    # expires_in: a JSON number or a numeric string.
    def seconds(value)
      number = value.is_a?(String) ? Float(value.strip, exception: false) : value
      number.is_a?(Numeric) && number.finite? ? number : nil
    end
  end
end
