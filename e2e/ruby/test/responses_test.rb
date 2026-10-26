# frozen_string_literal: true

require_relative 'test_helper'

class ResponsesTest < Minitest::Test
  include E2E

  def test_decodes_text_plain_as_a_string
    assert_equal 'hello, archon', client.responses.get_text
  end

  def test_decodes_octet_stream_as_bytes
    data = client.responses.get_binary
    assert_equal 256, data.bytesize
    assert_equal Encoding::BINARY, data.encoding
    assert_equal [0x00, 0xff], [data.getbyte(0), data.getbyte(255)]
  end

  def test_returns_nil_for_204_no_content
    status = nil
    assert_nil(client.responses.get_empty { |response| status = response.status })
    assert_equal 204, status
  end

  def test_returns_nil_for_an_empty_body_declared_as_json
    response = nil
    assert_nil(client.responses.get_empty_json { |r| response = r })
    assert_equal 200, response.status
    assert_equal '', response.body
  end
end
