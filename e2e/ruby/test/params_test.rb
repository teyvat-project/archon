# frozen_string_literal: true

require_relative 'test_helper'

class ParamsTest < Minitest::Test
  include E2E

  def test_serializes_all_path_styles
    echo = client.echo.echo_path_styles(simple: %w[a b], label: %w[a b], matrix: EdgeCases::EchoPathStylesMatrix.new(x: 1, y: 2))
    assert_equal 'GET', echo.method_
    assert_equal '/echo/path/a,b/.a.b/;x=1;y=2', echo.path
    assert_equal '', echo.query
  end

  def test_percent_encodes_reserved_characters
    echo = client.echo.echo_path_styles(simple: ['a/b?c#d e', '日本'], label: ['x'], matrix: { x: 1, y: 2 })
    assert_equal '/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2', echo.path
  end

  def test_serializes_all_query_styles
    echo = client.echo.echo_query_styles(
      form_exploded: %w[a b], form_flat: %w[a b], spaced: %w[a b], piped: [1, 2],
      filter: EdgeCases::EchoQueryStylesFilter.new(status: 'active', min_age: 3), reserved: 'a/b?c:d', limit: 10,
    )
    assert_equal '/echo/query', echo.path
    assert_equal [
      'formExploded=a&formExploded=b',
      'formFlat=a,b',
      'spaced=a%20b',
      'piped=1|2',
      'filter[status]=active&filter[minAge]=3',
      'reserved=a/b?c:d',
      'limit=10',
    ].join('&'), echo.query
  end

  def test_omits_unset_query_parameters
    assert_equal 'limit=1', client.echo.echo_query_styles(limit: 1).query
  end

  def test_sends_header_array_and_cookies
    echo = client.echo.echo_headers_cookies(x_request_ids: %w[a b], x_trace: 'trace-1', theme: 'dark', tags: %w[x y])
    assert_equal 'a,b', echo.headers['x-request-ids']
    assert_equal 'trace-1', echo.headers['x-trace']
    assert_equal 'theme=dark; tags=x,y', echo.headers['cookie']
    assert_equal({ 'theme' => 'dark', 'tags' => 'x,y' }, echo.cookies)
  end
end
