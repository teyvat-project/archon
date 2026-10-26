# frozen_string_literal: true

module Archon::Core
  # JSON values: `encode` converts Ruby values (models, times, dates, uploads, symbols) to their JSON form, and
  # `generate` writes compact JSON with numbers as JavaScript prints them, matching the other Archon runtimes.
  module Json
    ESCAPES = { '"' => '\\"', '\\' => '\\\\', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t', "\b" => '\\b', "\f" => '\\f' }.freeze
    private_constant :ESCAPES

    module_function

    # The JSON form of `value`: nil, true, false, Integer, Float, String, Array or Hash (with String keys). Models
    # and unknown union values become their `as_json`, Time an ISO 8601 date-time, Date YYYY-MM-DD, an Upload its
    # base64 content, a Symbol its name. Hash keys are written as given.
    def encode(value)
      case value
      when nil, true, false, Integer then value
      when Float
        raise ArgumentError, "#{value} cannot be written as JSON" unless value.finite?

        value
      when String then Json.utf8(value)
      when Symbol then value.to_s
      when Array then value.map { |item| encode(item) }
      when Hash then value.each_with_object({}) { |(key, item), out| out[key.to_s] = encode(item) }
      when Time then time(value)
      when Date then value.iso8601
      when Upload then [value.content].pack('m0')
      when Model, Unknown then value.as_json
      else
        raise ArgumentError, "#{value.class} cannot be written as JSON" unless value.respond_to?(:to_h)

        encode(value.to_h)
      end
    end

    # Compact JSON of `value` (see `encode`).
    def generate(value)
      out = +''
      write(out, encode(value))
      out
    end

    # Parses JSON text; raises DecodeError.
    def parse(text)
      JSON.parse(text)
    rescue JSON::ParserError => e
      raise DecodeError, "invalid JSON: #{e.message}"
    end

    # The text of a JSON value: strings unquoted, numbers as JavaScript prints them, booleans as true / false,
    # arrays and objects as compact JSON.
    def scalar_text(value)
      case value
      when String then value
      when true, false then value.to_s
      when Integer, Float then number_text(value)
      when nil then 'null'
      else
        out = +''
        write(out, value)
        out
      end
    end

    # A number as JavaScript's String(number) writes it: integers as they are, floats with the shortest round-trip
    # digits, in exponent form below 1e-6 and from 1e21 on, and "0" for negative zero.
    def number_text(number)
      return number.to_s if number.is_a?(Integer)
      return number.to_s if number.nan? || number.infinite?
      return '0' if number.zero?

      mantissa, exponent = number.abs.to_s.split('e')
      whole, fraction = mantissa.split('.')
      fraction = '' if fraction == '0'
      all = whole + fraction.to_s
      stripped = all.sub(/\A0+/, '')
      digits = stripped.sub(/0+\z/, '')
      point = whole.length - (all.length - stripped.length) + exponent.to_i
      sign = number.negative? ? '-' : ''
      k = digits.length
      text =
        if k <= point && point <= 21 then digits + ('0' * (point - k))
        elsif point.positive? && point <= 21 then "#{digits[0, point]}.#{digits[point..]}"
        elsif point > -6 && point <= 0 then "0.#{'0' * -point}#{digits}"
        else
          e = point - 1
          head = k == 1 ? digits : "#{digits[0]}.#{digits[1..]}"
          "#{head}e#{e.negative? ? '-' : '+'}#{e.abs}"
        end
      sign + text
    end

    # An ISO 8601 date-time with as many fraction digits as the time needs (none, 3, 6 or 9).
    def time(value)
      nsec = value.nsec
      digits = if nsec.zero? then 0
               elsif (nsec % 1_000_000).zero? then 3
               elsif (nsec % 1000).zero? then 6
               else 9
               end
      value.iso8601(digits)
    end

    # `value` as valid UTF-8 (binary strings are read as UTF-8; invalid bytes become U+FFFD).
    def utf8(value)
      case value.encoding
      when Encoding::UTF_8
        value.valid_encoding? ? value : value.scrub("�")
      when Encoding::BINARY, Encoding::US_ASCII
        value.dup.force_encoding(Encoding::UTF_8).scrub("�")
      else
        value.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "�")
      end
    end

    def write(out, value)
      case value
      when nil then out << 'null'
      when true, false then out << value.to_s
      when Integer, Float then out << number_text(value)
      when String then write_string(out, value)
      when Array
        out << '['
        value.each_with_index do |item, i|
          out << ',' if i.positive?
          write(out, item)
        end
        out << ']'
      when Hash
        out << '{'
        value.each_with_index do |(key, item), i|
          out << ',' if i.positive?
          write_string(out, key.to_s)
          out << ':'
          write(out, item)
        end
        out << '}'
      else
        write(out, encode(value))
      end
    end

    def write_string(out, value)
      out << '"'
      out << utf8(value).gsub(/["\\\u0000-\u001f]/) { |c| ESCAPES[c] || format('\\u%04x', c.ord) }
      out << '"'
    end

    private_class_method :write, :write_string
  end
end
