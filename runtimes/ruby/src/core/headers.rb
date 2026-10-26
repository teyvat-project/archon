# frozen_string_literal: true

module Archon::Core
  # HTTP headers: names are case-insensitive and keep the spelling they were first set with; a name can hold several
  # values.
  class Headers
    include Enumerable

    def initialize(headers = nil)
      @entries = {}
      headers&.each { |name, value| self[name] = value }
    end

    # The first value of `name`, or nil.
    def [](name)
      @entries[key(name)]&.last&.first
    end

    # Replaces the values of `name` (an Array sets several; nil removes the header).
    def []=(name, value)
      if value.nil?
        delete(name)
      else
        @entries[key(name)] = [name.to_s, Array(value).map(&:to_s)]
      end
    end

    # Appends a value to `name`.
    def add(name, value)
      entry = (@entries[key(name)] ||= [name.to_s, []])
      entry.last << value.to_s
      self
    end

    def delete(name)
      @entries.delete(key(name))
      nil
    end

    # Every value of `name`.
    def values(name)
      @entries[key(name)]&.last&.dup || []
    end

    def key?(name) = @entries.key?(key(name))
    def empty? = @entries.empty?
    def names = @entries.values.map(&:first)

    # Yields each name and value (a name with several values once per value).
    def each
      return enum_for(:each) unless block_given?

      @entries.each_value { |(name, values)| values.each { |value| yield name, value } }
    end

    # A Hash of each name to its values joined with ", ".
    def to_h
      @entries.values.to_h { |(name, values)| [name, values.join(', ')] }
    end

    def initialize_copy(other)
      super
      @entries = other.instance_variable_get(:@entries).transform_values { |(name, values)| [name, values.dup] }
    end

    def inspect = "#<#{self.class.name} #{to_h.inspect}>"

    private

    def key(name) = name.to_s.downcase
  end
end
