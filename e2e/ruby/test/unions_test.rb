# frozen_string_literal: true

require_relative 'test_helper'

class UnionsTest < Minitest::Test
  include E2E

  def describe(shape)
    case shape
    when EdgeCases::Circle then "circle r=#{shape.radius}"
    when EdgeCases::Square then "square s=#{shape.side}"
    else "unknown side=#{shape.raw['side']}"
    end
  end

  def test_narrows_a_discriminated_union_and_keeps_an_unknown_variant_as_raw_json
    shapes = client.unions.list_shapes
    assert_equal 'circle r=1.0; square s=2.0; unknown side=3', shapes.map { |s| describe(s) }.join('; ')
    assert_equal EdgeCases::Circle.new(kind: 'circle', radius: 1.0), shapes[0]
    assert_equal EdgeCases::Square.new(kind: EdgeCases::SquareKind::SQUARE, side: 2.0), shapes[1]
    assert_instance_of Core::Unknown, shapes[2]
    assert_equal 'hexagon', shapes[2].raw['kind']

    # Written back as received; a variant built without its tag gets it.
    assert_equal '[{"kind":"hexagon","side":3},{"kind":"circle","radius":5}]', Core::Json.generate([shapes[2], EdgeCases::Circle.new(radius: 5)])
  end

  def test_receives_an_untagged_union_by_trying_variants_in_order
    pets = client.unions.list_pets
    assert_equal [EdgeCases::Cat.new(name: 'Tama', meows: true), EdgeCases::Dog.new(name: 'Pochi', barks: true)], pets
  end

  def test_receives_known_and_unknown_enum_values_without_failing
    values = client.unions.get_enum_values
    assert_equal EdgeCases::Status::ACTIVE, values.status
    assert_equal EdgeCases::Priority::V_2, values.priority
    assert_equal EdgeCases::Status::PENDING, values.statuses[0]
    refute EdgeCases::Status.known?(values.statuses[1])
    assert_equal 'archived', values.statuses[1]
    assert_nil values.color
    refute EdgeCases::EnumValuesLevel.known?(values.level)
    assert_equal 'unknown-level', values.level
  end

  def test_reads_date_times_as_time_and_dates_as_date
    dates = client.unions.get_dates
    assert_equal Time.utc(2026, 10, 25, 12, 34, 56.789r), dates.created_at
    assert_equal '2000-01-02', dates.birthday.iso8601
    assert_instance_of Date, dates.birthday
    assert_nil dates.updated_at
    assert_equal 2, dates.timestamps.size
    assert_equal Time.utc(2026, 10, 25), dates.timestamps[0]
    assert_equal 9 * 60 * 60, dates.timestamps[0].utc_offset
    entry = dates.history[0]
    assert_equal Time.utc(2026, 10, 25), entry.at
    assert_equal 3, entry.days.sum(&:size)
    assert_equal Date.new(2026, 10, 3), entry.days[1][0]
    assert_equal Time.utc(2026, 1, 1), dates.by_key['first']
  end
end
