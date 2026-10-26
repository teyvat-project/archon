# frozen_string_literal: true

require_relative 'test_helper'

class ParamsTest < Minitest::Test
  include RuntimeTest

  COLORS = { 'string' => 'blue', 'array' => %w[blue black brown], 'object' => { 'R' => 100, 'G' => 200, 'B' => 150 } }.freeze

  def test_serializes_path_styles
    [
      [:matrix, false, 'string', ';color=blue'],
      [:matrix, false, 'array', ';color=blue,black,brown'],
      [:matrix, false, 'object', ';color=R,100,G,200,B,150'],
      [:matrix, true, 'string', ';color=blue'],
      [:matrix, true, 'array', ';color=blue;color=black;color=brown'],
      [:matrix, true, 'object', ';R=100;G=200;B=150'],
      [:label, false, 'string', '.blue'],
      [:label, false, 'array', '.blue,black,brown'],
      [:label, false, 'object', '.R,100,G,200,B,150'],
      [:label, true, 'string', '.blue'],
      [:label, true, 'array', '.blue.black.brown'],
      [:label, true, 'object', '.R=100.G=200.B=150'],
      [:simple, false, 'string', 'blue'],
      [:simple, false, 'array', 'blue,black,brown'],
      [:simple, false, 'object', 'R,100,G,200,B,150'],
      [:simple, true, 'string', 'blue'],
      [:simple, true, 'array', 'blue,black,brown'],
      [:simple, true, 'object', 'R=100,G=200,B=150'],
    ].each do |style, explode, kind, want|
      got = Core::Params.path('{color}', [spec('color', :path, style, explode: explode)], values.path('color', COLORS[kind]))
      assert_equal want, got, "#{style} explode=#{explode} #{kind}"
    end
  end

  def test_serializes_query_styles
    [
      [:form, false, 'string', 'color=blue'],
      [:form, false, 'array', 'color=blue,black,brown'],
      [:form, false, 'object', 'color=R,100,G,200,B,150'],
      [:form, true, 'string', 'color=blue'],
      [:form, true, 'array', 'color=blue&color=black&color=brown'],
      [:form, true, 'object', 'R=100&G=200&B=150'],
      [:space_delimited, false, 'array', 'color=blue%20black%20brown'],
      [:space_delimited, false, 'object', 'color=R%20100%20G%20200%20B%20150'],
      [:pipe_delimited, false, 'array', 'color=blue|black|brown'],
      [:pipe_delimited, false, 'object', 'color=R|100|G|200|B|150'],
      [:deep_object, true, 'object', 'color[R]=100&color[G]=200&color[B]=150'],
    ].each do |style, explode, kind, want|
      got = Core::Params.query([spec('color', :query, style, explode: explode)], values.query('color', COLORS[kind]))
      assert_equal want, got, "#{style} explode=#{explode} #{kind}"
    end
  end

  def test_percent_encodes_reserved_chars_in_path_values
    specs = [spec('name', :path)]
    assert_equal '/files/a%2Fb%3Fc%23d%20e', Core::Params.path('/files/{name}', specs, values.path('name', 'a/b?c#d e'))
    assert_equal '/files/%E6%97%A5%E6%9C%AC', Core::Params.path('/files/{name}', specs, values.path('name', '日本'))
  end

  def test_allow_reserved_keeps_reserved_chars_in_query_only
    query = spec('reserved', :query, allow_reserved: true)
    assert_equal 'reserved=a/b?c:d', Core::Params.query([query], values.query('reserved', 'a/b?c:d'))
    path = spec('name', :path, allow_reserved: true)
    assert_equal '/files/a%2Fb', Core::Params.path('/files/{name}', [path], values.path('name', 'a/b'))
  end

  def test_keeps_encode_uri_component_safe_chars
    assert_equal "q=!'()*~-_.", Core::Params.query([spec('q', :query)], values.query('q', "!'()*~-_."))
  end

  def test_skips_nil_values
    specs = %w[a b c].map { |name| spec(name, :query) }
    assert_equal 'c=x', Core::Params.query(specs, values.query('a', nil).query('b', nil).query('c', ['x', nil]))
  end

  def test_serializes_numbers_and_booleans_as_literals
    specs = %w[n f b l].map { |name| spec(name, :query) }
    v = values.query('n', 42).query('f', 1.5).query('b', true).query('l', 9_223_372_036_854_775_807)
    assert_equal 'n=42&f=1.5&b=true&l=9223372036854775807', Core::Params.query(specs, v)
  end

  def test_serializes_floats_like_javascript
    [
      [2.0, '2'], [1e10, '10000000000'], [1.5, '1.5'], [-2.5, '-2.5'], [1e21, '1e+21'], [1.5e21, '1.5e+21'],
      [123_456_789_012_345_680_000.0, '123456789012345680000'], [1e-7, '1e-7'], [1.5e-7, '1.5e-7'], [0.000001, '0.000001'],
      [0.1 + 0.2, '0.30000000000000004'], [5e-324, '5e-324'], [Float::MAX, '1.7976931348623157e+308'], [-0.0, '0'], [0.0, '0'],
    ].each do |value, want|
      assert_equal "n=#{want.gsub('+', '%2B')}", Core::Params.query([spec('n', :query)], values.query('n', value)), value.to_s
      assert_equal want, Core::Params.header(spec('n', :header), value), value.to_s
    end
  end

  def test_serializes_cookies_joined_with_semicolon_space
    specs = [spec('theme', :cookie), spec('tags', :cookie, explode: false)]
    assert_equal 'theme=dark; tags=x,y', Core::Params.cookie(specs, values.cookie('theme', 'dark').cookie('tags', %w[x y]))
    assert_equal '', Core::Params.cookie(specs, values)
  end

  def test_serializes_headers_without_encoding
    assert_equal 'a b,c/d', Core::Params.header(spec('X-Ids', :header), ['a b', 'c/d'])
  end

  def test_rejects_invalid_values
    specs = [spec('id', :path)]
    ['.', '..', ''].each do |value|
      assert_raises(ArgumentError, value) { Core::Params.path('/a/{id}', specs, values.path('id', value)) }
    end
    assert_raises(ArgumentError) { Core::Params.path('/a/{id}', specs, values) }
    assert_raises(ArgumentError) { Core::Params.header(spec('X-A', :header), ["a\r\nb"]) }
    assert_raises(ArgumentError) { values.query('bad', Float::NAN) }
  end

  def test_form_encoding_matches_url_search_params
    { 'a b&c' => 'a+b%26c', "*-._~!'" => '*-._%7E%21%27', '日' => '%E6%97%A5' }.each do |input, want|
      assert_equal want, Core::Percent.form(input)
    end
  end

  def test_encodes_utf8_and_invalid_bytes
    assert_equal '%F0%9F%98%80', Core::Percent.component('😀')
    assert_equal 'a%EF%BF%BDb', Core::Percent.component("a\xFFb".b)
    assert_equal 'a%EF%BF%BDb', Core::Percent.component((+"a\xFFb").force_encoding(Encoding::UTF_8))
  end

  def test_keeps_object_member_order_and_nests_deep_objects
    filter = spec('filter', :query, :deep_object, explode: true)
    value = { status: 'active', range: { min: 1, max: 9 }, tags: %w[a b] }
    assert_equal 'filter[status]=active&filter[range][min]=1&filter[range][max]=9&filter[tags]=a&filter[tags]=b',
                 Core::Params.query([filter], values.query('filter', value))
  end

  def test_writes_compact_json_like_the_other_runtimes
    assert_equal '{"a":[1,2.5,null,true],"b":"q\"\\\\\n\u001f/é","c":1}', Core::Json.generate({ a: [1, 2.5, nil, true], 'b' => "q\"\\\n\u001f/é", c: 1.0 })
  end
end
