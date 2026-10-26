# frozen_string_literal: true

module Archon::Core
  # A JSON property of a model: the Ruby member `name`, the `wire` name, its type, and whether it is required and
  # may be null.
  Field = Data.define(:name, :wire, :type, :required, :nullable)

  class Field
    def initialize(name:, wire:, type:, required: false, nullable: false)
      super
    end
  end

  # Behavior of generated models (Data classes): reading and writing JSON by the wire names of their properties.
  # Unknown JSON properties are ignored.
  module Model
    def self.included(base)
      base.extend(ClassMethods)
    end

    module ClassMethods
      # Declares the JSON properties, in order (returns them when called without arguments).
      def json_fields(*fields)
        @json_fields = fields.freeze unless fields.empty?
        @json_fields || []
      end

      # A model from a parsed JSON object (`from_json(JSON.parse(text))`). Raises DecodeError when a required
      # property is missing, a non-nullable one is null, or a value has the wrong type.
      def from_json(json) = decode_json(json, '$')

      def decode_json(json, path)
        raise DecodeError, "#{path}: expected an object for #{name}, got #{Types.describe(json)}" unless json.is_a?(Hash)

        args = {}
        json_fields.each do |field|
          if json.key?(field.wire)
            value = json[field.wire]
            if value.nil?
              raise DecodeError, "#{path}: required property #{field.wire.inspect} of #{name} is null" if field.required && !field.nullable

              args[field.name] = nil
            else
              args[field.name] = field.type.decode(value, "#{path}.#{field.wire}")
            end
          elsif field.required
            raise DecodeError, "#{path}: missing required property #{field.wire.inspect} of #{name}"
          end
        end
        new(**args)
      end

      # The model itself, or one built from a Hash of its keyword arguments (nil stays nil).
      def coerce(value)
        case value
        when nil, self then value
        when Hash then new(**value.transform_keys(&:to_sym))
        else raise ArgumentError, "expected #{name} or a Hash of its keyword arguments, got #{value.class}"
        end
      end
    end

    # The JSON object of the model, keyed by wire names (optional nils are left out).
    def as_json
      self.class.json_fields.each_with_object({}) do |field, out|
        value = public_send(field.name)
        next if value.nil? && !field.required

        out[field.wire] = value.nil? ? nil : field.type.encode(value)
      end
    end

    # The JSON object of the model (see `as_json`), keyed by wire names.
    def to_h(&block) = block ? as_json.to_h(&block) : as_json

    def to_json(*) = Json.generate(as_json)
  end

  # A union value no variant matched (or whose discriminator is unknown), kept as its JSON and written back as is.
  Unknown = Data.define(:raw)

  class Unknown
    def as_json = raw
    def to_json(*) = Json.generate(raw)
  end

  # Behavior of generated union modules: `from_json` picks the variant.
  module Union
    # Picks the variant by the string value of `property`; `mapping` maps each value to a type.
    def discriminator(property, mapping)
      @discriminator = [property, mapping.freeze].freeze
    end

    # The variants tried in order (untagged unions).
    def variants(*types)
      @variants = types.freeze
    end

    # The variant a parsed JSON value is: a model, a scalar, or Unknown.
    def from_json(json) = decode_json(json, '$')

    def decode_json(json, path)
      if @discriminator
        property, mapping = @discriminator
        type = json.is_a?(Hash) && json[property].is_a?(String) ? mapping[json[property]] : nil
        return type ? type.decode(json, path) : Unknown.new(raw: json)
      end
      (@variants || []).each do |type|
        return type.decode(json, path)
      rescue DecodeError
        next
      end
      Unknown.new(raw: json)
    end
  end
end
