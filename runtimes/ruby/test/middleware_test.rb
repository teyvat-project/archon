# frozen_string_literal: true

require_relative 'test_helper'

class MiddlewareTest < Minitest::Test
  include RuntimeTest

  def setup
    @statuses = []
    @server = TestServer.new do |_|
      status, headers = @statuses.shift || [200, {}]
      [status, headers, '']
    end
    @sleeps = []
  end

  def teardown = @server.close

  def operation(http_method = 'GET', body: nil)
    Core::Operation.new(name: 'op', http_method: http_method, path: '/r', body: body, errors: { 'default' => :text })
  end

  def retry_mw(**options) = Core::Middleware::Retry.new(sleep: ->(s) { @sleeps << s }, random: -> { 0.5 }, **options)

  def test_retry_honours_retry_after
    @statuses = [[503, { 'Retry-After' => '2' }], [429, { 'Retry-After' => 'Wed, 21 Oct 2015 07:28:10 GMT' }], [503, { 'Retry-After' => '999' }], [200, {}]]
    now = -> { Time.httpdate('Wed, 21 Oct 2015 07:28:00 GMT') }
    attempts = []
    probe = ->(req, ctx, nxt) { attempts << ctx.attempt; nxt.(req) }
    Core::Client.new(base_url: @server.url, middleware: [retry_mw(max_attempts: 4, now: now), probe]).call(operation)
    assert_equal [2, 10, 60.0], @sleeps
    assert_equal [1, 2, 3, 4], attempts
  end

  def test_retry_only_retries_what_it_may
    @statuses = [[503, {}], [503, {}], [503, {}]]
    assert_equal 503, assert_raises(Core::ApiError) { Core::Client.new(base_url: @server.url, middleware: [retry_mw]).call(operation) }.status
    assert_equal 3, @server.requests.size

    @statuses = [[503, {}], [200, {}]]
    assert_raises(Core::ApiError) { Core::Client.new(base_url: @server.url, middleware: [retry_mw]).call(operation('POST')) }
    @statuses = [[400, {}], [200, {}]]
    assert_raises(Core::ApiError) { Core::Client.new(base_url: @server.url, middleware: [retry_mw]).call(operation) }
    @statuses = [[503, {}], [200, {}]]
    stream = values.body(Core::IOBody.new(StringIO.new('x')))
    assert_raises(Core::ApiError) { Core::Client.new(base_url: @server.url, middleware: [retry_mw]).call(operation('PUT', body: :binary), stream) }
    assert_equal 6, @server.requests.size
  end

  def test_retry_retries_network_errors_but_not_timeouts
    failures = [Core::TransportError.new('reset'), Core::TransportError.new('reset')]
    flaky = ->(req, _ctx, nxt) { (e = failures.shift) ? raise(e) : nxt.(req) }
    Core::Client.new(base_url: @server.url, middleware: [retry_mw, flaky]).call(operation)
    assert_equal 2, @sleeps.size

    timeouts = ->(_req, _ctx, _nxt) { raise Core::TimeoutError, 'slow' }
    assert_raises(Core::TimeoutError) { Core::Client.new(base_url: @server.url, middleware: [retry_mw, timeouts]).call(operation) }
    failures = [Core::TransportError.new('reset')]
    assert_raises(Core::TransportError) do
      Core::Client.new(base_url: @server.url, middleware: [retry_mw(retry_network_errors: false), flaky]).call(operation)
    end
  end

  def test_retry_uses_equal_jitter
    mw = Core::Middleware::Retry.new(base_delay: 1.0, max_delay: 3.0, random: -> { 1.0 })
    assert_equal [1.0, 2.0, 3.0, 3.0], (1..4).map { |attempt| mw.send(:backoff, attempt) }
    assert_equal 0.5, Core::Middleware::Retry.new(base_delay: 1.0, random: -> { 0.0 }).send(:backoff, 1)
  end

  def test_retry401_sends_once_more_with_fresh_credentials
    @statuses = [[401, {}], [401, {}]]
    token = 'old'
    seen = []
    retry401 = Core::Middleware::Retry401.new do |context, response|
      seen << [context.attempt, response.status]
      token = 'new'
      true
    end
    schemes = { 'bearer' => Core::SecuritySchemeSpec.new(kind: :http_bearer) }
    c = Core::Client.new(base_url: @server.url, middleware: [retry401], security_schemes: schemes, auth: { 'bearer' => -> { token } })
    op = Core::Operation.new(name: 'op', http_method: 'GET', path: '/r', security: [{ 'bearer' => [] }])
    assert_equal 401, assert_raises(Core::ApiError) { c.call(op) }.status
    assert_equal [[1, 401]], seen
    assert_equal ['Bearer old', 'Bearer new'], @server.requests.map { |r| r.header('authorization') }
    assert_raises(ArgumentError) { Core::Middleware::Retry401.new }
  end

  def test_logging_masks_credentials
    lines = []
    ticks = [10.0, 10.0425]
    logging = Core::Middleware::Logging.new(logger: ->(line) { lines << line }, include_headers: true, redact_headers: ['X-Secret'],
                                            redact_query: ['token'], clock: -> { ticks.shift })
    schemes = { 'key' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :header, name: 'X-API-Key'),
                'q' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :query, name: 'api_key') }
    headers = { 'Authorization' => 'Bearer t', 'x-api-key' => 'k', 'X-Secret' => 's', 'X-Plain' => 'p', 'Cookie' => 'c=1' }
    base = "#{@server.url}/?api_key=k&Token=t&keep=1#frag"
    Core::Client.new(base_url: base, middleware: [logging], headers: headers, security_schemes: schemes).call(operation)
    assert_equal "→ GET #{@server.url}/r?api_key=***&Token=***&keep=1", lines[0]
    assert_equal ['  Accept: */*', '  Authorization: ***', '  Cookie: ***', '  x-api-key: ***', '  X-Plain: p', '  X-Secret: ***'], lines[1..-2]
    assert_equal '← 200 (42ms)', lines[-1]

    logger = Class.new { attr_reader :infos; def initialize = @infos = []; def info(line) = @infos << line }.new
    Core::Client.new(base_url: @server.url, middleware: [Core::Middleware::Logging.new(logger: logger)]).call(operation)
    assert_equal 2, logger.infos.size
  end

  def test_user_agent
    Core::Client.new(base_url: @server.url, middleware: [Core::Middleware::UserAgent.new('archon-test/1.0')]).call(operation)
    assert_equal 'archon-test/1.0', @server.last.header('user-agent')
  end
end
