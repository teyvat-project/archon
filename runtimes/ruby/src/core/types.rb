# frozen_string_literal: true

module Archon::Core
  # How a JSON value maps to a Ruby value. A type decodes a JSON value (raising DecodeError when it does not fit)
  # and encodes a Ruby value back to JSON. Generated models describe their properties with these.
  module Types
    # The base type: values pass through Json.encode.
    class Type
      def decode(json, _path) = json
      def encode(value) = Json.encode(value)
    end

    # A JSON scalar checked by `accept` and converted by `convert`.
    class Scalar < Type
      def initialize(description, accept, convert = nil)
        super()
        @description = description
        @accept = accept
        @convert = convert
        freeze
      end

      def decode(json, path)
        raise DecodeError, "#{path}: expected #{@description}, got #{Types.describe(json)}" unless @accept.(json)

        @convert ? @convert.(json, path) : json
      end
    end

    # Base64 text as a binary String (OpenAPI `format: byte`).
    class Bytes < Scalar
      def encode(value) = [value.to_s].pack('m0')
    end

    class ArrayOf < Type
      attr_reader :item

      def initialize(item)
        super()
        @item = item
        freeze
      end

      def decode(json, path)
        raise DecodeError, "#{path}: expected an array, got #{Types.describe(json)}" unless json.is_a?(Array)

        json.each_with_index.map { |value, i| item.decode(value, "#{path}[#{i}]") }
      end

      def encode(value) = value.map { |v| item.encode(v) }
    end

    class MapOf < Type
      attr_reader :value

      def initialize(value)
        super()
        @value = value
        freeze
      end

      def decode(json, path)
        raise DecodeError, "#{path}: expected an object, got #{Types.describe(json)}" unless json.is_a?(Hash)

        json.to_h { |key, v| [key, value.decode(v, "#{path}.#{key}")] }
      end

      def encode(hash) = hash.to_h { |key, v| [key.to_s, value.encode(v)] }
    end

    # Accepts null as well.
    class Nullable < Type
      def initialize(type)
        super()
        @type = type
        freeze
      end

      def decode(json, path) = json.nil? ? nil : @type.decode(json, path)
      def encode(value) = value.nil? ? nil : @type.encode(value)
    end

    # A generated model or union, resolved lazily (`-> { Node }`) so models can refer to each other and to
    # themselves.
    class Ref < Type
      def initialize(target)
        super()
        @target = target
        freeze
      end

      def target = @target.is_a?(Proc) ? @target.call : @target
      def decode(json, path) = target.decode_json(json, path)
    end

    STRING = Scalar.new('a string', ->(v) { v.is_a?(String) })
    INTEGER = Scalar.new('an integer', ->(v) { v.is_a?(Integer) || (v.is_a?(Float) && v.finite? && v == v.floor) }, ->(v, _) { v.to_i })
    NUMBER = Scalar.new('a number', ->(v) { v.is_a?(Numeric) }, ->(v, _) { v.to_f })
    BOOLEAN = Scalar.new('a boolean', ->(v) { [true, false].include?(v) })
    TIME = Scalar.new('an RFC 3339 date-time', ->(v) { v.is_a?(String) && v.match?(/\A\d{4}-\d{2}-\d{2}[Tt ]/) },
                      ->(v, path) { Types.parse_time(v, path) })
    DATE = Scalar.new('a YYYY-MM-DD date', ->(v) { v.is_a?(String) && v.match?(/\A\d{4}-\d{2}-\d{2}\z/) },
                      ->(v, path) { Types.parse_date(v, path) })
    BYTES = Bytes.new('a base64 string', ->(v) { v.is_a?(String) }, ->(v, _) { v.unpack1('m') })
    UPLOAD = Scalar.new('a base64 string', ->(v) { v.is_a?(String) }, ->(v, _) { Upload.new(v.unpack1('m')) })
    ANY = Type.new.freeze

    module_function

    def array(item) = ArrayOf.new(item)
    def map(value) = MapOf.new(value)
    def nullable(type) = Nullable.new(type)
    def ref(target) = Ref.new(target)

    def parse_time(text, path)
      Time.iso8601(text.tr('t ', 'TT').sub(/z\z/, 'Z'))
    rescue ArgumentError
      raise DecodeError, "#{path}: #{text.inspect} is not an RFC 3339 date-time"
    end

    def parse_date(text, path)
      Date.iso8601(text)
    rescue ArgumentError
      raise DecodeError, "#{path}: #{text.inspect} is not a valid date"
    end

    # A short description of a JSON value for error messages.
    def describe(json)
      case json
      when nil then 'null'
      when Hash then 'an object'
      when Array then 'an array'
      when String then 'a string'
      when true, false then 'a boolean'
      else 'a number'
      end
    end
  end
end
