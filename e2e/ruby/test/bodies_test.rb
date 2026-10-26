# frozen_string_literal: true

require_relative 'test_helper'

class BodiesTest < Minitest::Test
  include E2E

  def test_sends_a_json_body
    payload = EdgeCases::JsonPayload.new(name: 'archon', count: 3, tags: %w[a b], nested: EdgeCases::Nested.new(flag: true))
    echo = client.echo.echo_json(payload)
    assert_equal 'POST', echo.method_
    assert_equal 'application/json', echo.content_type
    assert_equal payload, EdgeCases::JsonPayload.from_json(JSON.parse(echo.body))
    # Optional nils are not written (the "unset" vs "null" distinction is out of scope).
    refute_includes echo.body, 'note'
    assert_equal payload, EdgeCases::JsonPayload.from_json(JSON.parse(client.echo.echo_json({ name: 'archon', count: 3, tags: %w[a b], nested: payload.nested }).body))
  end

  def test_sends_a_url_encoded_form_body_with_repeated_array_fields
    echo = client.echo.echo_form(EdgeCases::EchoFormBody.new(name: 'a b&c', count: 2, tags: %w[x y]))
    assert_equal 'application/x-www-form-urlencoded', echo.content_type
    assert_equal 'name=a+b%26c&count=2&tags=x&tags=y', echo.body
  end

  def test_sends_a_multipart_body_with_file_names_and_sizes
    echo = client.echo.echo_multipart(
      EdgeCases::EchoMultipartBody.new(
        title: 'hello',
        file: Core::Upload.new("\0" * 10, filename: 'data.bin', content_type: 'application/octet-stream'),
        attachments: [Core::Upload.new('abc', filename: 'a.txt'), Core::Upload.new('hello', filename: 'b.txt')],
      ),
    )
    assert_match %r{\Amultipart/form-data; boundary=}, echo.content_type
    assert_equal '{"title":"hello"}', echo.body
    assert_equal 'file data.bin 10; attachments a.txt 3; attachments b.txt 5', echo.files.map { |f| "#{f.field} #{f.name} #{f.size}" }.join('; ')
  end

  def test_sends_a_binary_body
    echo = client.echo.echo_binary(Core::Upload.new('raw bytes'))
    assert_equal 'application/octet-stream', echo.content_type
    assert_equal '9', echo.headers['content-length']
    assert_equal 'raw bytes', echo.body
  end

  def test_sends_a_plain_text_body
    echo = client.echo.echo_text('hello, text')
    assert_equal 'text/plain', echo.content_type
    assert_equal 'hello, text', echo.body
  end

  def test_round_trips_a_recursive_all_of_tree_the_server_assigning_ids
    tree = EdgeCases::Node.new(
      id: 'placeholder', name: 'root', labels: { 'env' => 'test' },
      children: [
        EdgeCases::Node.new(id: 'placeholder', name: 'a', children: [EdgeCases::Node.new(id: 'placeholder', name: 'a1', children: [])]),
        EdgeCases::Node.new(id: 'placeholder', name: 'b', children: []),
      ],
    )
    status = nil
    root = client.nodes.create_node(tree) { |response| status = response.status }
    assert_equal 201, status
    assert_equal 'n1', root.id
    assert_nil root.parent_id
    assert_equal 'root', root.name
    assert_equal 'test', root.labels['env']
    assert_equal %w[n2 n4], root.children.map(&:id)
    assert_equal %w[n1 n1], root.children.map(&:parent_id)
    a1 = root.children[0].children[0]
    assert_equal 'n3 n2 a1', "#{a1.id} #{a1.parent_id} #{a1.name}"
    assert_empty root.children[1].children
  end
end
