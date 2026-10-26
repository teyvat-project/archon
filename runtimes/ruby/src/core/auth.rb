# frozen_string_literal: true

module Archon::Core
  # HTTP Basic credentials.
  Basic = Data.define(:username, :password)

  class Basic
    # Basic credentials from a Basic, a Hash with :username / :password, or a [username, password] pair.
    def self.coerce(value)
      case value
      when Basic then value
      when Hash
        h = value.transform_keys(&:to_sym)
        new(username: h.fetch(:username).to_s, password: h.fetch(:password).to_s)
      when Array then new(username: value.fetch(0).to_s, password: value.fetch(1).to_s)
      else raise ArgumentError, "expected Basic credentials, got #{value.class}"
      end
    end
  end

  # OAuth2 / OpenID Connect credentials: a ready `access_token` (a String, or a callable returning one, called on
  # every send), or a grant the runtime runs and caches (`client_credentials` / `refresh_token`).
  class OAuth2
    # The client credentials grant. `scopes` are requested in addition to those the operation needs; `token_url`
    # overrides the spec's (relative URLs resolve against the base URL); `client_auth` is :basic
    # (client_secret_basic) or :post (client_secret_post).
    ClientCredentials = Data.define(:client_id, :client_secret, :scopes, :token_url, :client_auth)

    class ClientCredentials
      def initialize(client_id:, client_secret:, scopes: [], token_url: nil, client_auth: :basic)
        super
      end
    end

    # The refresh token grant. `client_secret` is optional (public clients send only client_id); `on_refreshed` is
    # called with the TokenSet of every token response that carries a (rotated) refresh token.
    RefreshToken = Data.define(:refresh_token, :client_id, :client_secret, :token_url, :client_auth, :on_refreshed)

    class RefreshToken
      def initialize(refresh_token:, client_id:, client_secret: nil, token_url: nil, client_auth: :basic, on_refreshed: nil)
        super
      end
    end

    attr_reader :access_token, :client_credentials, :refresh_token

    def initialize(access_token: nil, client_credentials: nil, refresh_token: nil)
      @access_token = access_token
      @client_credentials = client_credentials.is_a?(Hash) ? ClientCredentials.new(**client_credentials.transform_keys(&:to_sym)) : client_credentials
      @refresh_token = refresh_token.is_a?(Hash) ? RefreshToken.new(**refresh_token.transform_keys(&:to_sym)) : refresh_token
    end

    def configured? = !(access_token.nil? && client_credentials.nil? && refresh_token.nil?)

    # OAuth2 credentials from an OAuth2, a Hash of its keyword arguments, or an access token (a String or a callable).
    def self.coerce(value)
      case value
      when OAuth2 then value
      when Hash then new(**value.transform_keys(&:to_sym))
      when String then new(access_token: value)
      else value.respond_to?(:call) ? new(access_token: value) : raise(ArgumentError, "expected OAuth2 credentials, got #{value.class}")
      end
    end
  end

  # Applies authentication innermost in the chain (spec §8.2) and refreshes managed OAuth2 tokens once on 401.
  class AuthLayer
    # The credentials of one send: each scheme's value is read on first use and then kept, so selecting the
    # requirement, applying it and re-applying it on 401 all see the same credentials.
    class Snapshot
      def initialize(auth)
        @auth = auth
        @values = {}
      end

      def value(scheme)
        return @values[scheme] if @values.key?(scheme)

        value = @auth.nil? ? nil : @auth[scheme]
        value = @auth[scheme.to_sym] if value.nil? && @auth.is_a?(Hash)
        @values[scheme] = value
      end
    end

    def initialize(client)
      @client = client
      @mutex = Mutex.new
      @managers = {}
    end

    def call(request, context, next_)
      snapshot = Snapshot.new(@client.auth)
      requirement, missing = AuthLayer.select(context.security) { |scheme| configured?(snapshot, scheme) }
      raise AuthError.missing(missing) if missing

      used = apply(snapshot, request, requirement || {}, context)
      response = next_.call(request)
      return response unless response.status == 401 && !used.empty? && request.replayable?

      used.each { |manager, token| manager.invalidate(token) }
      apply(snapshot, request, requirement || {}, context)
      next_.call(request)
    end

    # Evaluates the OR-of-AND requirements in order and picks the first alternative whose schemes are all
    # configured. An empty alternative (optional auth) is used only when no other one is satisfiable. Returns the
    # requirement (nil for anonymous) and the schemes missing for the first alternative (nil when satisfied).
    def self.select(requirements, &configured)
      optional = false
      first = nil
      requirements.each do |requirement|
        if requirement.empty?
          optional = true
          next
        end
        first ||= requirement
        return [requirement, nil] if requirement.keys.all?(&configured)
      end
      return [nil, nil] if first.nil? || optional

      [nil, first.keys.reject(&configured)]
    end

    private

    def configured?(snapshot, scheme)
      spec = @client.security_schemes[scheme]
      # Schemes the generator cannot apply (http digest, mutualTLS, ...) are left out of the scheme table;
      # custom_auth is responsible for them.
      return !@client.custom_auth.nil? if spec.nil?

      value = snapshot.value(scheme)
      return false if value.nil?

      case spec.kind
      when :http_bearer, :api_key then value.is_a?(String) || value.respond_to?(:call)
      when :http_basic then value.is_a?(Basic) || value.is_a?(Hash) || value.is_a?(Array) || value.respond_to?(:call)
      when :oauth2, :open_id_connect then OAuth2.coerce(value).configured?
      else false
      end
    rescue ArgumentError
      false
    end

    # Applies the requirement; returns each token manager used with the token it supplied.
    def apply(snapshot, request, requirement, context)
      used = []
      requirement.each do |scheme, scopes|
        spec = @client.security_schemes[scheme]
        next if spec.nil? # left to custom_auth

        value = snapshot.value(scheme)
        credentials(scheme) do
          case spec.kind
          when :http_bearer
            request.headers['Authorization'] = "Bearer #{AuthLayer.token(value)}"
          when :http_basic
            basic = Basic.coerce(value.respond_to?(:call) && !value.is_a?(Hash) ? value.call : value)
            request.headers['Authorization'] = "Basic #{[Json.utf8("#{basic.username}:#{basic.password}")].pack('m0')}"
          when :api_key
            key = AuthLayer.token(value)
            case spec.location
            when :header then request.headers[spec.name] = key
            when :query then request.set_query_parameter(spec.name, key)
            when :cookie then AuthLayer.set_cookie(request.headers, spec.name, Percent.component(key))
            end
          when :oauth2, :open_id_connect
            oauth = OAuth2.coerce(value)
            token =
              if oauth.access_token
                AuthLayer.token(oauth.access_token)
              else
                manager = manager(scheme, spec, value, oauth)
                manager.token(scopes).tap { |t| used << [manager, t] }
              end
            request.headers['Authorization'] = "Bearer #{token}"
          end
        end
      end
      @client.custom_auth&.call(request, context)
      used
    end

    def credentials(scheme)
      yield
    rescue AuthError
      raise
    rescue StandardError => e
      raise AuthError.new("obtaining credentials for security scheme #{scheme}: #{e.message}", schemes: [scheme])
    end

    # The token manager of a scheme, rebuilt when the scheme's value is replaced (a manager serves only its own).
    def manager(scheme, spec, value, oauth)
      @mutex.synchronize do
        entry = @managers[scheme]
        return entry[1] if entry && entry[0].equal?(value)

        token_url = oauth.refresh_token && spec.refresh_url ? spec.refresh_url : spec.token_url
        manager = TokenManager.new(config: oauth, token_url: token_url, base_url: @client.base_url, scheme: scheme,
                                   transport: @client.transport, timeout: @client.timeout)
        @managers[scheme] = [value, manager]
        manager
      end
    end

    class << self
      # A bearer token or API key from a String or a callable (called on every send).
      def token(value)
        token = value.respond_to?(:call) ? value.call : value
        raise ArgumentError, "the credential must be a String, got #{token.class}" unless token.is_a?(String)

        token
      end

      def set_cookie(headers, name, value)
        kept = headers['Cookie'].to_s.split(';').map(&:strip).reject { |part| part.empty? || part.split('=', 2).first == name }
        headers['Cookie'] = [*kept, "#{name}=#{value}"].join('; ')
      end
    end
  end
end
