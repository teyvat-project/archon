# frozen_string_literal: true

require_relative 'test_helper'

class RedirectTest < Minitest::Test
  include E2E

  def test_drops_credentials_when_a_redirect_crosses_origins
    c = client(auth: EdgeCases::Auth.new(api_key_header: 'test-key'), headers: { 'Authorization' => 'Bearer test-token' })
    response = nil
    echo = c.middleware.redirect_cross_origin { |r| response = r }
    assert_equal 200, response.status
    secondary = URI(SECONDARY_URL)
    final = URI(response.url)
    assert_equal [secondary.scheme, secondary.host, secondary.port], [final.scheme, final.host, final.port]
    assert_equal '/echo/headers', echo.path
    %w[x-api-key authorization].each { |name| refute echo.headers.key?(name), "#{name} reached the other origin" }
  end
end
