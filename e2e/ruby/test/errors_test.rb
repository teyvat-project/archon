# frozen_string_literal: true

require_relative 'test_helper'

class ErrorsTest < Minitest::Test
  include E2E

  def test_returns_the_success_body_for_200
    assert client.errors.get_error(status: 200).ok
  end

  def test_raises_a_typed_error_body_for_404
    error = assert_raises(EdgeCases::ApiError) { client.errors.get_error(status: 404) }
    assert_equal 404, error.status
    assert_instance_of EdgeCases::NotFoundError, error.body
    assert_equal 'Not found errors/404', "#{error.body.message} #{error.body.resource}"
  end

  def test_raises_the_400_validation_error_body
    error = assert_raises(EdgeCases::ApiError) { client.errors.get_error(status: 400) }
    assert_instance_of EdgeCases::ValidationError, error.body
    assert_equal 'Validation failed', error.body.message
    assert_equal ['status invalid'], error.body.fields.map { |f| "#{f.name} #{f.reason}" }
  end

  def test_raises_the_default_error_body_for_any_other_status
    [418, 500].each do |status|
      error = assert_raises(EdgeCases::ApiError) { client.errors.get_error(status: status) }
      assert_equal status, error.status
      assert_instance_of EdgeCases::Error, error.body
      assert_equal status, error.body.code
    end
  end
end
