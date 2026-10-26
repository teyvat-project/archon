# frozen_string_literal: true

require_relative 'test_helper'
require_relative 'model_test'

class ClientTest < Minitest::Test
  include RuntimeTest

  def setup
    @handler = ->(_) { [200, { 'Content-Type' => 'application/json' }, '{"ok":true}'] }
    @server = TestServer.new { |req| @handler.call(req) }
  end

  def teardown
    @server.close
  end

  def client(**options) = Core::Client.new(base_url: @server.url, **options)

  def operation(**fields)
    Core::Operation.new(name: 'op', http_method: 'GET', path: '/things', success: :json, **fields)
  end

  def test_sends_json_with_the_media_type_and_accept
    op = operation(http_method: 'POST', body: :json, media_type: 'application/vnd.test+json')
    result = client.call(op, values.json_body(ModelFixtures::Circle.new(radius: 1.5)))
    assert_equal({ 'ok' => true }, result)
    request = @server.last
    assert_equal 'POST', request.http_method
    assert_equal '{"kind":"circle","radius":1.5}', request.body
    assert_equal 'application/vnd.test+json', request.header('content-type')
    assert_equal 'application/json', request.header('accept')
  end

  def test_sends_form_and_multipart_bodies
    client.call(operation(http_method: 'POST', body: :form), values.form_body({ name: 'a b&c', count: 2, tags: %w[x y], none: nil }))
    assert_equal 'name=a+b%26c&count=2&tags=x&tags=y', @server.last.body
    assert_equal 'application/x-www-form-urlencoded', @server.last.header('content-type')

    multipart = Core::MultipartBody.new.field('title', 'hello').field('n', 3)
                                       .file('file', Core::Upload.new("\x00\x01", filename: 'a "b".bin'))
                                       .files('more', ['x', Core::Upload.new('y', filename: 'y.txt', content_type: 'text/plain')])
    op = operation(http_method: 'POST', body: :multipart)
    client.call(op, values.body(multipart))
    client.call(op, values.body(multipart))
    first, second = @server.requests.last(2)
    assert_equal first.body, second.body
    boundary = multipart.boundary
    assert_equal "multipart/form-data; boundary=#{boundary}", first.header('content-type')
    assert_equal [
      "--#{boundary}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nhello\r\n",
      "--#{boundary}\r\nContent-Disposition: form-data; name=\"n\"\r\n\r\n3\r\n",
      "--#{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a %22b%22.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\x01\r\n",
      "--#{boundary}\r\nContent-Disposition: form-data; name=\"more\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n",
      "--#{boundary}\r\nContent-Disposition: form-data; name=\"more\"; filename=\"y.txt\"\r\nContent-Type: text/plain\r\n\r\ny\r\n",
      "--#{boundary}--\r\n",
    ].join.b, first.body
  end

  def test_sends_text_binary_and_streamed_bodies
    client.call(operation(http_method: 'POST', body: :text), values.text_body('héllo'))
    assert_equal 'héllo'.b, @server.last.body
    assert_equal 'text/plain', @server.last.header('content-type')

    client.call(operation(http_method: 'POST', body: :binary, media_type: 'application/octet-stream'), values.binary_body("\xFF\x00".b))
    assert_equal "\xFF\x00".b, @server.last.body
    assert_equal '2', @server.last.header('content-length')

    client.call(operation(http_method: 'POST', body: :binary), values.binary_body(Core::Upload.new('png', content_type: 'image/png')))
    assert_equal 'image/png', @server.last.header('content-type')

    stream = Core::IOBody.new(StringIO.new('streamed'), 'text/plain')
    client.call(operation(http_method: 'POST', body: :binary), values.body(stream))
    assert_equal 'streamed', @server.last.body
    assert_equal 'chunked', @server.last.header('transfer-encoding')
    refute stream.replayable?
    assert_raises(ArgumentError) { stream.open }
  end

  def test_keeps_the_base_path_and_sends_the_target_byte_for_byte
    specs = [spec('name', :path), spec('piped', :query, :pipe_delimited, explode: false), spec('filter', :query, :deep_object, explode: true)]
    op = operation(path: '/files/{name}', params: specs)
    v = values.path('name', 'a/b').query('piped', [1, 2]).query('filter', { a: 'b' })
    Core::Client.new(base_url: "#{@server.url}/api/?x=%41").call(op, v)
    assert_equal '/api/files/a%2Fb?x=%41&piped=1|2&filter[a]=b', @server.last.target
  end

  def test_orders_headers_and_joins_cookies
    op = operation(params: [spec('X-Ids', :header), spec('X-Mode', :header), spec('theme', :cookie)])
    v = values.header('X-Ids', %w[a b]).header('X-Mode', 'param').cookie('theme', 'dark')
    c = client(headers: { 'X-Mode' => 'client', 'X-Client' => 'yes', 'Cookie' => 'sid=1' })
    c.call(op, v, { headers: { 'x-mode' => 'call' } })
    request = @server.last
    assert_equal 'a,b', request.header('x-ids')
    assert_equal 'call', request.header('x-mode')
    assert_equal 'yes', request.header('x-client')
    assert_equal 'sid=1; theme=dark', request.header('cookie')
    assert_equal 'application/json', request.header('accept')
    # Net::HTTP's Accept-Encoding / Accept defaults give way; nothing is sent twice.
    assert_equal 1, request.headers['accept'].size
    client.call(operation(success: :text))
    assert_equal '*/*', @server.last.header('accept')
  end

  def test_decodes_success_bodies
    @handler = ->(_) { json(200, { 'kind' => 'circle', 'radius' => 2 }) }
    assert_equal ModelFixtures::Circle.new(radius: 2.0), client.call(operation(result: Core::Types.ref(-> { ModelFixtures::Shape })), nil)

    @handler = ->(_) { [200, { 'Content-Type' => 'text/plain' }, 'héllo'] }
    text = client.call(operation(success: :text))
    assert_equal 'héllo', text
    assert_equal Encoding::UTF_8, text.encoding
    assert_equal 'héllo'.b, client.call(operation(success: :binary))

    @handler = ->(_) { [204, {}, ''] }
    responses = []
    assert_nil client.call(operation) { |response| responses << response }
    assert_equal [204], responses.map(&:status)
    @handler = ->(_) { [200, {}, ''] }
    assert_nil client.call(operation(result: Core::Types::STRING))
    assert_nil client.call(operation(success: nil))

    @handler = ->(_) { [200, {}, '{not json'] }
    error = assert_raises(Core::DecodeError) { client.call(operation) }
    assert_equal 200, error.status
    assert_equal '{not json', error.raw_body
    @handler = ->(_) { json(200, { 'kind' => 'circle' }) }
    assert_raises(Core::DecodeError) { client.call(operation(result: Core::Types.ref(-> { ModelFixtures::Circle }))) }
  end

  def test_raises_api_errors_with_typed_bodies
    errors = { '404' => Core::Types.ref(-> { ModelFixtures::Square }), '4xx' => :text, 'default' => Core::Types.ref(-> { ModelFixtures::Circle }) }
    op = operation(errors: errors)
    @handler = ->(_) { json(404, { 'kind' => 'square', 'side' => 1 }, 'X-Id' => '7') }
    error = assert_raises(Core::ApiError) { client.call(op) }
    assert_equal 404, error.status
    assert_equal ModelFixtures::Square.new(side: 1.0), error.body
    assert_equal '7', error.headers['x-id']
    assert_equal "#{@server.url}/things", error.url
    assert_equal 'HTTP 404', error.message

    @handler = ->(_) { [409, {}, 'conflict'] }
    assert_equal 'conflict', assert_raises(Core::ApiError) { client.call(op) }.body

    @handler = ->(_) { [500, {}, 'not json'] }
    error = assert_raises(Core::ApiError) { client.call(op) }
    assert_nil error.body
    assert_kind_of Core::DecodeError, error.decode_error
    assert_equal 'not json', error.raw_body

    @handler = ->(_) { [500, {}, ''] }
    error = assert_raises(Core::ApiError) { client.call(op) }
    assert_nil error.body
    assert_nil error.decode_error
  end

  def test_raises_transport_errors
    closed = TCPServer.new('127.0.0.1', 0)
    port = closed.addr[1]
    closed.close
    error = assert_raises(Core::TransportError) { Core::Client.new(base_url: "http://127.0.0.1:#{port}").call(operation) }
    refute error.timeout?

    @handler = lambda { |_|
      sleep 1
      [200, {}, '']
    }
    error = assert_raises(Core::TimeoutError) { client(timeout: 0.2).call(operation) }
    assert error.timeout?
    assert_raises(ArgumentError) { Core::Client.new(base_url: '/relative').call(operation) }
  end

  def test_runs_middleware_in_order_with_auth_innermost
    order = []
    tag = lambda do |name|
      lambda do |request, context, next_|
        order << "#{name}:before:#{context.attempt}"
        response = next_.call(request)
        order << "#{name}:after"
        response
      end
    end
    c = client(middleware: [tag.('mw1')], custom_auth: ->(_req, _ctx) { order << 'auth' })
    c.use(tag.('mw2'))
    c.use { |request, _context, next_| next_.(request) }
    seen = nil
    c.use(->(req, ctx, nxt) { seen = [ctx.operation_name, ctx.http_method, ctx.path_template, ctx.extensions]; nxt.(req) })
    c.call(operation(security: [{ 'custom' => [] }]), nil, { extensions: { trace: 1 } })
    assert_equal %w[mw1:before:1 mw2:before:1 auth mw2:after mw1:after], order
    assert_equal ['op', 'GET', '/things', { trace: 1 }], seen
    assert_raises(ArgumentError) { c.use(1) }
  end

  def test_follows_redirects_dropping_credentials_across_origins
    other = TestServer.new { |_| [200, {}, ''] }
    @handler = lambda do |req|
      case req.target
      when %r{\A/things} then [302, { 'Location' => "#{other.url}/elsewhere?api_key=k&keep=1" }, '']
      else [200, {}, '']
      end
    end
    schemes = { 'key' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :header, name: 'X-Key'),
                'q' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :query, name: 'api_key') }
    c = client(security_schemes: schemes, headers: { 'Authorization' => 'Bearer t', 'X-Key' => 'k', 'Cookie' => 'a=1', 'X-Other' => 'o' })
    final = nil
    c.call(operation(success: nil)) { |response| final = response.url }
    request = other.last
    assert_equal '/elsewhere?keep=1', request.target
    assert_nil request.header('authorization')
    assert_nil request.header('x-key')
    assert_nil request.header('cookie')
    assert_equal 'o', request.header('x-other')
    assert_equal "#{other.url}/elsewhere?keep=1", final
  ensure
    other&.close
  end

  def test_keeps_credentials_on_the_same_origin_and_switches_303_to_get
    @handler = lambda do |req|
      case req.target
      when '/things' then [303, { 'Location' => '/done' }, '']
      when '/done' then [200, {}, '']
      end
    end
    c = client(headers: { 'Authorization' => 'Bearer t' })
    c.call(operation(http_method: 'POST', body: :text, success: nil), values.text_body('x'))
    request = @server.last
    assert_equal ['GET', '/done', 'Bearer t'], [request.http_method, request.target, request.header('authorization')]
    assert_nil request.header('content-type')
    assert_equal '', request.body
  end

  def test_re_sends_the_body_on_307_but_not_a_streamed_one
    @handler = ->(req) { req.target == '/things' ? [307, { 'Location' => '/again' }, ''] : [200, {}, ''] }
    client.call(operation(http_method: 'POST', body: :text, success: nil), values.text_body('x'))
    assert_equal %w[x x], @server.requests.map(&:body)
    stream = values.body(Core::IOBody.new(StringIO.new('y')))
    error = assert_raises(Core::ApiError) { client.call(operation(http_method: 'POST', body: :binary, success: nil), stream) }
    assert_equal 307, error.status
    assert_equal %w[x x y], @server.requests.map(&:body)
  end

  def test_stops_after_twenty_redirects
    @handler = ->(_) { [302, { 'Location' => '/things' }, ''] }
    assert_match(/too many redirects/, assert_raises(Core::TransportError) { client.call(operation) }.message)
    assert_equal 21, @server.requests.size
  end

  def test_request_set_query_parameter_keeps_other_bytes
    request = Core::Request.new(http_method: 'GET', url: 'https://x.test/a?b=%41&api_key=old&c=1|2#frag')
    request.set_query_parameter('api_key', 'n w')
    assert_equal 'https://x.test/a?b=%41&c=1|2&api_key=n%20w', request.url
  end

  def test_resolves_urls_and_origins
    assert_equal 'https://x.test/a/c?d', Core::Url.resolve('https://x.test/a/b', 'c?d')
    assert_equal 'https://x.test/c', Core::Url.resolve('https://x.test/a/b', '../../c')
    assert_equal 'http://y.test/z', Core::Url.resolve('https://x.test/a', 'http://y.test/z')
    assert_equal 'https://y.test/z', Core::Url.resolve('https://x.test/a', '//y.test/z')
    assert_equal Core::Url.origin('HTTPS://X.test'), Core::Url.origin('https://u@x.test:443/p')
    refute_equal Core::Url.origin('http://x.test'), Core::Url.origin('http://x.test:8080')
  end
end
