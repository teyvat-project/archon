# frozen_string_literal: true

require_relative 'test_helper'

class MiddlewareTest < Minitest::Test
  include E2E

  def test_retries_503_responses_until_the_endpoint_succeeds
    key = unique_key('retry')
    data = client(middleware: [Core::Middleware::Retry.new]).middleware.flaky(key: key, fail: 2)
    assert_equal key, data.key
    assert_equal 3, data.attempts
  end

  def test_gives_up_after_max_attempts_and_raises_the_typed_503
    c = client(middleware: [Core::Middleware::Retry.new(max_attempts: 2)])
    error = assert_raises(EdgeCases::ApiError) { c.middleware.flaky(key: unique_key('give-up'), fail: 5) }
    assert_equal 503, error.status
    assert_equal 503, error.body.code
  end

  def test_resends_once_after_a_401_when_the_token_was_swapped_by_retry401
    token = 'expired-token'
    swaps = []
    retry401 = Core::Middleware::Retry401.new do |context, _response|
      swaps << context.attempt
      token = 'test-token'
      true
    end
    echo = client(auth: EdgeCases::Auth.new(bearer_auth: -> { token }), middleware: [retry401]).auth.auth_bearer
    assert_equal 'Bearer test-token', echo.headers['authorization']
    assert_equal [1], swaps
  end

  def test_masks_credentials_in_logs
    lines = []
    # Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
    with_query_key = lambda do |request, _context, next_|
      request.set_query_parameter('api_key', 'test-key')
      next_.call(request)
    end
    logging = Core::Middleware::Logging.new(logger: ->(line) { lines << line }, include_headers: true)
    c = client(headers: { 'Authorization' => 'Bearer test-token', 'X-API-Key' => 'test-key' }, middleware: [with_query_key, logging])
    echo = c.echo.echo_headers_cookies(x_request_ids: ['r1'], theme: 'dark')
    # The server did receive the credentials...
    assert_equal 'Bearer test-token', echo.headers['authorization']
    assert_equal 'test-key', echo.headers['x-api-key']
    assert_equal 'api_key=test-key', echo.query

    # ...but the log did not.
    logged = lines.join("\n")
    %w[test-token test-key dark].each { |secret| refute_includes logged, secret }
    assert_equal "→ GET #{BASE_URL}/echo/headers?api_key=***", lines[0]
    headers = lines[1..-2].map { |line| line.strip.downcase }
    ['authorization: ***', 'x-api-key: ***', 'cookie: ***', 'x-request-ids: r1'].each { |want| assert_includes headers, want }
    assert_match(/\A← 200 \(\d+ms\)\z/, lines[-1])
  end

  def test_sets_the_user_agent
    echo = client(middleware: [Core::Middleware::UserAgent.new('archon-e2e/1.0')]).echo.echo_headers_cookies(x_request_ids: ['r1'], theme: 'dark')
    assert_equal 'archon-e2e/1.0', echo.headers['user-agent']
  end

  def test_runs_middleware_in_registration_order_config_first_then_use
    order = []
    tag = lambda do |name|
      lambda do |request, _context, next_|
        order << ">#{name}"
        trace = request.headers['X-Trace']
        request.headers['X-Trace'] = trace ? "#{trace},#{name}" : name
        response = next_.call(request)
        order << "<#{name}"
        response
      end
    end
    c = client(middleware: [tag.('a'), tag.('b')])
    c.use(tag.('c'))
    echo = c.echo.echo_headers_cookies(x_request_ids: ['r1'], theme: 'dark')
    assert_equal 'a,b,c', echo.headers['x-trace']
    assert_equal '>a >b >c <c <b <a', order.join(' ')
  end
end
