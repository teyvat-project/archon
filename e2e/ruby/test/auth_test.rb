# frozen_string_literal: true

require_relative 'test_helper'

class AuthTest < Minitest::Test
  include E2E

  def client_credentials = Core::OAuth2.new(client_credentials: { client_id: 'client-id', client_secret: 'client-secret' })

  def test_bearer
    echo = client(auth: EdgeCases::Auth.new(bearer_auth: 'test-token')).auth.auth_bearer
    assert_equal 'Bearer test-token', echo.headers['authorization']
  end

  def test_basic
    status = nil
    client(auth: EdgeCases::Auth.new(basic_auth: Core::Basic.new(username: 'user', password: 'pass'))).auth.auth_basic { |r| status = r.status }
    assert_equal 200, status
    client(auth: EdgeCases::Auth.new(basic_auth: { username: 'user', password: 'pass' })).auth.auth_basic
  end

  def test_api_key_in_a_header
    assert_equal 'test-key', client(auth: EdgeCases::Auth.new(api_key_header: 'test-key')).auth.auth_api_key_header.headers['x-api-key']
  end

  def test_api_key_in_the_query
    assert_equal 'api_key=test-key', client(auth: EdgeCases::Auth.new(api_key_query: -> { 'test-key' })).auth.auth_api_key_query.query
  end

  def test_api_key_in_a_cookie
    assert_equal({ 'session' => 'test-key' }, client(auth: EdgeCases::Auth.new(api_key_cookie: 'test-key')).auth.auth_api_key_cookie.cookies)
  end

  def test_rejects_a_wrong_credential_with_a_typed_401
    error = assert_raises(EdgeCases::ApiError) { client(auth: EdgeCases::Auth.new(bearer_auth: 'wrong')).auth.auth_bearer }
    assert_equal 401, error.status
    assert_instance_of EdgeCases::Error, error.body
    assert_equal 401, error.body.code
    refute_empty error.body.message
  end

  def test_raises_auth_error_without_sending_when_required_auth_is_missing
    before = requests('/auth/bearer')
    error = assert_raises(EdgeCases::AuthError) { client.auth.auth_bearer }
    assert_equal ['bearerAuth'], error.schemes
    assert_equal before, requests('/auth/bearer')
  end

  def test_sends_anonymously_when_auth_is_optional_and_not_configured
    refute client.auth.auth_optional.headers.key?('authorization')
  end

  def test_uses_the_credential_for_optional_auth_when_it_is_configured
    assert_equal 'Bearer test-token', client(auth: EdgeCases::Auth.new(bearer_auth: 'test-token')).auth.auth_optional.headers['authorization']
  end

  def test_requires_every_scheme_of_an_and_requirement
    before = requests('/auth/and')
    assert_raises(EdgeCases::AuthError) { client(auth: EdgeCases::Auth.new(bearer_auth: 'test-token')).auth.auth_and }
    assert_equal before, requests('/auth/and')
    status = nil
    client(auth: EdgeCases::Auth.new(bearer_auth: 'test-token', api_key_header: 'test-key')).auth.auth_and { |r| status = r.status }
    assert_equal 200, status
  end

  def test_oauth2_obtains_a_token_with_client_credentials_from_the_relative_token_url
    before = tokens_issued
    echo = client(auth: EdgeCases::Auth.new(oauth2: client_credentials)).auth.auth_o_auth2
    assert_match(/\ABearer /, echo.headers['authorization'])
    assert_equal before + 1, tokens_issued
  end

  def test_oauth2_obtains_a_token_with_the_refresh_token_grant
    refreshed = []
    refresh = Core::OAuth2::RefreshToken.new(refresh_token: 'test-refresh-token', client_id: 'client-id', client_secret: 'client-secret',
                                              on_refreshed: ->(tokens) { refreshed << tokens.refresh_token })
    status = nil
    client(auth: EdgeCases::Auth.new(oauth2: Core::OAuth2.new(refresh_token: refresh))).auth.auth_o_auth2 { |r| status = r.status }
    assert_equal 200, status
    assert_equal 1, refreshed.size
    refute_includes [nil, '', 'test-refresh-token'], refreshed[0]
  end

  def test_oauth2_renews_the_token_before_it_expires_instead_of_waiting_for_a_401
    c = client(auth: EdgeCases::Auth.new(oauth2: client_credentials))
    before_tokens = tokens_issued
    before_requests = requests('/auth/oauth2')
    first = c.auth.auth_o_auth2
    # The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
    sleep 2.1
    second = c.auth.auth_o_auth2
    refute_equal first.headers['authorization'], second.headers['authorization']
    assert_equal 2, tokens_issued - before_tokens
    assert_equal 2, requests('/auth/oauth2') - before_requests
  end

  def test_oauth2_issues_a_single_token_for_concurrent_requests_on_a_cold_client
    c = client(auth: EdgeCases::Auth.new(oauth2: client_credentials))
    before = tokens_issued
    headers = Array.new(5) { Thread.new { c.auth.auth_o_auth2.headers['authorization'] } }.map(&:value)
    assert_equal 1, headers.uniq.size
    assert_equal 1, tokens_issued - before
  end
end
