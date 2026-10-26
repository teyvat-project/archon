# frozen_string_literal: true

module Archon::Core
  # Percent-encoding over the UTF-8 bytes of a string (invalid UTF-8 becomes U+FFFD, as TextEncoder would).
  module Percent
    ALPHANUMERIC = [*'A'..'Z', *'a'..'z', *'0'..'9'].join
    COMPONENT = "#{ALPHANUMERIC}-_.!~*'()".bytes.freeze
    RESERVED = "#{ALPHANUMERIC}-_.!~*'():/?#[]@$&+,;=".bytes.freeze
    FORM = "#{ALPHANUMERIC}*-._".bytes.freeze
    private_constant :ALPHANUMERIC, :COMPONENT, :RESERVED, :FORM

    module_function

    # JavaScript's encodeURIComponent: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is encoded.
    def component(value) = encode(value, COMPONENT, space_as_plus: false)

    # `component` keeping the RFC 3986 reserved characters `:/?#[]@$&+,;=` (query allowReserved).
    def reserved(value) = encode(value, RESERVED, space_as_plus: false)

    # application/x-www-form-urlencoded as URLSearchParams writes it: alphanumerics and `*-._` stay, space is `+`.
    def form(value) = encode(value, FORM, space_as_plus: true)

    def encode(value, keep, space_as_plus:)
      out = +''
      Json.utf8(value.to_s).each_byte do |byte|
        if keep.include?(byte)
          out << byte.chr
        elsif byte == 0x20 && space_as_plus
          out << '+'
        else
          out << format('%%%02X', byte)
        end
      end
      out
    end

    private_class_method :encode
  end
end
