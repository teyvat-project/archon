# frozen_string_literal: true

require_relative 'test_helper'

class AuthTest < Minitest::Test
  include RuntimeTest

  SCHEMES = {
    'bearer' => Core::SecuritySchemeSpec.new(kind: :http_bearer),
    'basic' => Core::SecuritySchemeSpec.new(kind: :http_basic),
    'header' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :header, name: 'X-API-Key'),
    'query' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :query, name: 'api_key'),
    'cookie' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :cookie, name: 'session'),
    'oauth2' => Core::SecuritySchemeSpec.new(kind: :oauth2, token_url: '/oauth/token', refresh_url: '/oauth/refresh'),
  }.freeze

  # Issues at-1, at-2, ... (expiring after @expires_in seconds when set) and accepts only issued, unrevoked tokens.
  def setup
    @issued = 0
    @valid = []
    @token_requests = []
    @expires_in = nil
    @token_delay = 0
    @mutex = Mutex.new
    @server = TestServer.new do |req|
      if req.target.start_with?('/oauth/')
        @token_requests << req
        sleep @token_delay
        token = @mutex.synchronize { "at-#{@issued += 1}" }
        @valid << token
        body = { 'access_token' => token, 'token_type' => 'Bearer' }
        body['expires_in'] = @expires_in if @expires_in
        body['refresh_token'] = "rt-#{@issued}" if req.body.include?('refresh_token')
        json(200, body)
      elsif req.target.start_with?('/oauth2-only') && (@reject_all || !@valid.include?(req.header('authorization').to_s.delete_prefix('Bearer ')))
        [401, {}, '']
      else
        [200, {}, '']
      end
    end
  end

  def teardown = @server.close

  def operation(*schemes, path: '/secure', optional: false)
    security = [schemes.to_h { |s| [s, ['read']] }]
    security << {} if optional
    Core::Operation.new(name: 'op', http_method: 'GET', path: path, security: security)
  end

  def client(auth, **options) = Core::Client.new(base_url: @server.url, security_schemes: SCHEMES, auth: auth, **options)


  def test_selects_security_alternatives
    none = ->(_) { false }
    only_bearer = ->(name) { name == 'bearer' }
    assert_equal [nil, nil], Core::AuthLayer.select([], &none)
    assert_equal [nil, nil], Core::AuthLayer.select([{ 'bearer' => [] }, {}], &none)
    assert_equal [nil, ['bearer']], Core::AuthLayer.select([{ 'bearer' => [] }], &none)
    assert_equal [{ 'bearer' => [] }, nil], Core::AuthLayer.select([{ 'bearer' => [], 'key' => [] }, { 'bearer' => [] }], &only_bearer)
  end

  def test_applies_each_scheme_kind
    auth = { 'bearer' => -> { 'from-provider' }, 'basic' => { username: 'user', password: 'päss' }, 'header' => 'h-key',
             'query' => 'q key', 'cookie' => 'c;key' }
    c = client(auth, headers: { 'Cookie' => 'theme=dark' })
    c.call(operation('bearer'))
    assert_equal 'Bearer from-provider', @server.last.header('authorization')
    c.call(operation('basic'))
    assert_equal 'Basic dXNlcjpww6Rzcw==', @server.last.header('authorization')
    c.call(operation('header'))
    assert_equal 'h-key', @server.last.header('x-api-key')
    c.call(operation('query'))
    assert_equal '/secure?api_key=q%20key', @server.last.target
    c.call(operation('cookie'))
    assert_equal 'theme=dark; session=c%3Bkey', @server.last.header('cookie')
    client({ basic: Core::Basic.new(username: 'a', password: 'b') }).call(operation('basic'))
    assert_equal 'Basic YTpi', @server.last.header('authorization')
  end

  def test_raises_auth_error_before_sending
    error = assert_raises(Core::AuthError) { client(nil).call(operation('bearer', 'header')) }
    assert_equal %w[bearer header], error.schemes
    assert_equal [], @server.requests
    client(nil).call(operation('bearer', optional: true))
    assert_nil @server.last.header('authorization')
    error = assert_raises(Core::AuthError) { client({ 'bearer' => -> { raise 'vault down' } }).call(operation('bearer')) }
    assert_match(/vault down/, error.message)
    assert_raises(Core::AuthError) { client({ 'bearer' => -> { 1 } }).call(operation('bearer')) }
  end

  def test_reapplies_fresh_credentials_when_middleware_sends_again
    n = 0
    twice = lambda do |request, _context, next_|
      next_.(request)
      next_.(request)
    end
    client({ 'bearer' => -> { "t#{n += 1}" } }, middleware: [twice]).call(operation('bearer'))
    assert_equal 'Bearer t2', @server.last.header('authorization')
  end

  def test_reads_credentials_once_per_send
    auth = Class.new do
      attr_reader :reads

      def initialize = @reads = 0

      def [](scheme)
        @reads += 1
        @reads == 1 && scheme == 'bearer' ? 't' : nil
      end
    end.new
    client(auth).call(operation('bearer', optional: true))
    assert_equal ['Bearer t', 1], [@server.last.header('authorization'), auth.reads]
  end

  def test_custom_auth_covers_unknown_schemes
    calls = []
    custom = lambda do |request, context|
      calls << context.operation_name
      request.headers['X-Digest'] = 'd'
    end
    client(nil, custom_auth: custom).call(operation('digest'))
    assert_equal ['op'], calls
    assert_equal 'd', @server.last.header('x-digest')
    assert_raises(Core::AuthError) { client(nil).call(operation('digest')) }
  end

  def test_oauth2_client_credentials_with_basic_client_auth_and_scopes
    oauth = Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: 's', scopes: ['extra'] })
    c = client({ 'oauth2' => oauth })
    c.call(operation('oauth2'))
    c.call(operation('oauth2'))
    assert_equal 1, @token_requests.size
    token_request = @token_requests[0]
    assert_equal ['POST', '/oauth/token'], [token_request.http_method, token_request.target]
    assert_equal 'grant_type=client_credentials&scope=extra+read', token_request.body
    assert_equal "Basic #{['id:s'].pack('m0')}", token_request.header('authorization')
    assert_equal 'application/x-www-form-urlencoded', token_request.header('content-type')
    assert_equal 'Bearer at-1', @server.last.header('authorization')

    post = Core::OAuth2.new(client_credentials: Core::OAuth2::ClientCredentials.new(client_id: 'id', client_secret: 's', client_auth: :post))
    client({ 'oauth2' => post }).call(operation('oauth2'))
    assert_equal 'grant_type=client_credentials&scope=read&client_id=id&client_secret=s', @token_requests.last.body
    assert_nil @token_requests.last.header('authorization')
    client({ 'oauth2' => 'ready' }).call(operation('oauth2'))
    assert_equal 'Bearer ready', @server.last.header('authorization')
  end

  def test_oauth2_renews_ahead_of_expiry
    @expires_in = 20 # inside the 30 s leeway, so every send renews
    c = client({ 'oauth2' => { client_credentials: { client_id: 'id', client_secret: 's' } } })
    c.call(operation('oauth2'))
    c.call(operation('oauth2'))
    assert_equal 2, @token_requests.size
    @expires_in = '3600'
    c.call(operation('oauth2'))
    c.call(operation('oauth2'))
    assert_equal 3, @token_requests.size
  end

  def test_oauth2_issues_one_token_for_concurrent_requests
    @token_delay = 0.2
    c = client({ 'oauth2' => Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: 's' }) })
    threads = Array.new(5) { Thread.new { c.call(operation('oauth2')) } }
    threads.each(&:join)
    assert_equal 1, @token_requests.size
    assert_equal ['Bearer at-1'], @server.requests.reject { |r| r.target.start_with?('/oauth/') }.map { |r| r.header('authorization') }.uniq
  end

  def test_oauth2_shares_a_failed_fetch_with_waiters
    manager = Core::TokenManager.new(config: Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: nil }),
                                     token_url: nil, base_url: @server.url, scheme: 'oauth2')
    errors = Array.new(3) { Thread.new { manager.token(['x']) rescue $! } }.map(&:value)
    assert(errors.all? { |e| e.is_a?(Core::AuthError) && e.message.include?('no token URL') })
  end

  def test_oauth2_refresh_token_grant_rotates
    refreshed = []
    refresh = Core::OAuth2::RefreshToken.new(refresh_token: 'rt-0', client_id: 'id', on_refreshed: ->(tokens) { refreshed << tokens.refresh_token })
    c = client({ 'oauth2' => Core::OAuth2.new(refresh_token: refresh) })
    @expires_in = 1
    c.call(operation('oauth2'))
    c.call(operation('oauth2'))
    assert_equal ['/oauth/refresh'], @token_requests.map(&:target).uniq
    assert_equal ['grant_type=refresh_token&refresh_token=rt-0&client_id=id', 'grant_type=refresh_token&refresh_token=rt-1&client_id=id'],
                 @token_requests.map(&:body)
    assert_equal %w[rt-1 rt-2], refreshed
  end

  def test_oauth2_retries_once_on_401_and_rebuilds_for_a_new_value
    auth = { 'oauth2' => { client_credentials: { client_id: 'id', client_secret: 's' } } }
    c = client(auth)
    op = operation('oauth2', path: '/oauth2-only')
    c.call(op)
    @valid.delete('at-1') # revoked server-side
    c.call(op)
    assert_equal 2, @token_requests.size
    assert_equal 'Bearer at-2', @server.last.header('authorization')
    auth['oauth2'] = { client_credentials: { client_id: 'id', client_secret: 's' } }
    c.call(op)
    assert_equal 3, @token_requests.size, 'a replaced value gets its own manager'
    @reject_all = true
    assert_equal 401, assert_raises(Core::ApiError) { c.call(op) }.status
    assert_equal 4, @token_requests.size, 'only one refresh per send'
  end

  def test_oauth2_token_endpoint_failures
    [[400, { 'error' => 'invalid_client' }], [200, '{'], [200, { 'token_type' => 'Bearer' }]].each do |status, body|
      server = TestServer.new { |_| [status, {}, body.is_a?(String) ? body : Core::Json.generate(body)] }
      manager = Core::TokenManager.new(config: Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: nil }),
                                       token_url: server.url, base_url: '', scheme: 'oauth2')
      error = assert_raises(Core::AuthError) { manager.token }
      assert_equal ['oauth2'], error.schemes
      server.close
    end
    manager = Core::TokenManager.new(config: Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: nil }),
                                     token_url: '/relative', base_url: '', scheme: 'oauth2')
    assert_raises(Core::AuthError) { manager.token }
    closed = TCPServer.new('127.0.0.1', 0)
    url = "http://127.0.0.1:#{closed.addr[1]}/token"
    closed.close
    manager = Core::TokenManager.new(config: Core::OAuth2.new(client_credentials: { client_id: 'id', client_secret: nil }),
                                     token_url: url, base_url: '', scheme: 'oauth2')
    assert_match(/token request failed/, assert_raises(Core::AuthError) { manager.token }.message)
  end
end
