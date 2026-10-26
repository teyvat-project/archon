# frozen_string_literal: true

require_relative 'test_helper'

module ModelFixtures
  Core = Archon::Core

  Circle = ::Data.define(:kind, :radius)

  class Circle
    include Core::Model

    def initialize(radius:, kind: 'circle')
      super
    end

    json_fields Core::Field.new(name: :kind, wire: 'kind', type: Core::Types::STRING, required: true),
                Core::Field.new(name: :radius, wire: 'radius', type: Core::Types::NUMBER, required: true)
  end

  Square = ::Data.define(:kind, :side)

  class Square
    include Core::Model

    def initialize(side:, kind: 'square')
      super
    end

    json_fields Core::Field.new(name: :kind, wire: 'kind', type: Core::Types::STRING, required: true),
                Core::Field.new(name: :side, wire: 'side', type: Core::Types::NUMBER, required: true)
  end

  module Shape
    extend Core::Union

    discriminator 'kind', { 'circle' => Core::Types.ref(-> { Circle }), 'square' => Core::Types.ref(-> { Square }) }
  end

  module Loose
    extend Core::Union

    variants Core::Types.ref(-> { Circle }), Core::Types::TIME, Core::Types::INTEGER, Core::Types::STRING
  end

  Node = ::Data.define(:name, :children, :parent_id, :created_at, :born, :blob, :file, :tags, :extra)

  class Node
    include Core::Model

    def initialize(name:, children:, parent_id:, created_at: nil, born: nil, blob: nil, file: nil, tags: nil, extra: nil)
      super
    end

    json_fields Core::Field.new(name: :name, wire: 'name', type: Core::Types::STRING, required: true),
                Core::Field.new(name: :children, wire: 'children', type: Core::Types.array(Core::Types.ref(-> { Node })), required: true),
                Core::Field.new(name: :parent_id, wire: 'parentId', type: Core::Types::STRING, required: true, nullable: true),
                Core::Field.new(name: :created_at, wire: 'createdAt', type: Core::Types::TIME),
                Core::Field.new(name: :born, wire: 'born', type: Core::Types::DATE),
                Core::Field.new(name: :blob, wire: 'blob', type: Core::Types::BYTES),
                Core::Field.new(name: :file, wire: 'file', type: Core::Types::UPLOAD),
                Core::Field.new(name: :tags, wire: 'tags', type: Core::Types.map(Core::Types.nullable(Core::Types::INTEGER))),
                Core::Field.new(name: :extra, wire: 'extra', type: Core::Types::ANY)
  end
end

class ModelTest < Minitest::Test
  include RuntimeTest
  include ModelFixtures

  def test_reads_and_writes_json_by_wire_names
    json = {
      'name' => 'root', 'parentId' => nil, 'unknown' => 1, 'createdAt' => '2026-10-25T09:00:00.5+09:00', 'born' => '2000-01-02',
      'blob' => 'aGk=', 'file' => 'AAE=', 'tags' => { 'a' => 1, 'b' => nil }, 'extra' => [1, { 'x' => nil }],
      'children' => [{ 'name' => 'a', 'children' => [], 'parentId' => 'root' }]
    }
    node = Node.from_json(json)
    assert_equal 'root', node.name
    assert_nil node.parent_id
    assert_equal Time.utc(2026, 10, 25, 0, 0, 0.5r), node.created_at
    assert_equal 9 * 3600, node.created_at.utc_offset
    assert_equal Date.new(2000, 1, 2), node.born
    assert_equal 'hi', node.blob
    assert_equal "\x00\x01".b, node.file.content
    assert_equal({ 'a' => 1, 'b' => nil }, node.tags)
    assert_equal Node.new(name: 'a', children: [], parent_id: 'root'), node.children[0]
    assert_equal json.except('unknown').merge('createdAt' => '2026-10-25T09:00:00.500+09:00'), node.to_h
    assert_equal Core::Json.generate(node.to_h), node.to_json
  end

  def test_leaves_optional_nils_out_and_writes_required_nulls
    assert_equal({ 'name' => 'x', 'children' => [], 'parentId' => nil }, Node.new(name: 'x', children: [], parent_id: nil).to_h)
  end

  def test_rejects_missing_null_and_mistyped_required_properties
    error = assert_raises(Core::DecodeError) { Node.from_json({ 'name' => 'x', 'parentId' => nil }) }
    assert_match(/missing required property "children" of ModelFixtures::Node/, error.message)
    assert_raises(Core::DecodeError) { Node.from_json({ 'name' => 'x', 'children' => [] }) }
    assert_raises(Core::DecodeError) { Node.from_json({ 'name' => nil, 'children' => [], 'parentId' => nil }) }
    error = assert_raises(Core::DecodeError) { Node.from_json({ 'name' => 'x', 'children' => [{ 'name' => 1 }], 'parentId' => nil }) }
    assert_match(/\$\.children\[0\]\.name: expected a string, got a number/, error.message)
    assert_raises(Core::DecodeError) { Node.from_json([]) }
    assert_raises(Core::DecodeError) { Node.from_json({ 'name' => 'x', 'children' => [], 'parentId' => nil, 'born' => '2000-13-01' }) }
  end

  def test_coerces_hashes_of_keyword_arguments
    assert_equal Circle.new(radius: 2), Circle.coerce({ radius: 2 })
    assert_equal Circle.new(radius: 2), Circle.coerce({ 'radius' => 2, 'kind' => 'circle' })
    assert_nil Circle.coerce(nil)
    assert_raises(ArgumentError) { Circle.coerce(1) }
  end

  def test_picks_a_discriminated_variant_and_keeps_unknown_tags
    assert_equal Circle.new(radius: 1.0), Shape.from_json({ 'kind' => 'circle', 'radius' => 1 })
    assert_equal Square.new(side: 2.0), Shape.from_json({ 'kind' => 'square', 'side' => 2 })
    unknown = Shape.from_json({ 'kind' => 'hexagon', 'side' => 3 })
    assert_equal Core::Unknown.new(raw: { 'kind' => 'hexagon', 'side' => 3 }), unknown
    assert_equal '[{"kind":"hexagon","side":3},{"kind":"circle","radius":5}]', Core::Json.generate([unknown, Circle.new(radius: 5)])
    assert_raises(Core::DecodeError) { Shape.from_json({ 'kind' => 'circle' }) }
  end

  def test_tries_untagged_variants_in_order
    assert_equal Circle.new(radius: 1.0), Loose.from_json({ 'kind' => 'circle', 'radius' => 1 })
    assert_equal Time.utc(2026, 1, 1), Loose.from_json('2026-01-01T00:00:00Z')
    assert_equal 3, Loose.from_json(3)
    assert_equal 'plain', Loose.from_json('plain')
    assert_equal Core::Unknown.new(raw: [true]), Loose.from_json([true])
  end

  def test_writes_times_with_the_digits_they_need
    assert_equal '2026-01-01T00:00:00Z', Core::Json.time(Time.utc(2026, 1, 1))
    assert_equal '2026-01-01T00:00:00.120Z', Core::Json.time(Time.utc(2026, 1, 1, 0, 0, 0.12r))
    assert_equal '2026-01-01T00:00:00.000001+09:00', Core::Json.time(Time.new(2026, 1, 1, 0, 0, 0.000001r, '+09:00'))
  end
end
