# frozen_string_literal: true

module Archon::Core
  # OpenAPI style / explode serialization (RFC 6570), matching the TypeScript, C#, Kotlin and Go runtimes byte for
  # byte. Values are JSON values (see Json.encode); nils inside arrays and objects are skipped.
  module Params
    PLACEHOLDER = /\{([^{}]+)\}/
    private_constant :PLACEHOLDER

    module_function

    def path(template, specs, values)
      by_name = specs.select { |s| s.location == :path }.to_h { |s| [s.name, s] }
      # Serialized values never contain '/', so template segments map 1:1 onto URL path segments.
      template.split('/', -1).map do |segment|
        used = []
        output = segment.gsub(PLACEHOLDER) do |match|
          name = Regexp.last_match(1)
          spec = by_name[name]
          next match unless spec

          raise ArgumentError, "missing required path parameter #{name.inspect}" unless values.key?(:path, name)

          used << name.inspect
          path_value(spec, values.get(:path, name))
        end
        # URL parsers drop '.' / '..' segments (and '..' pops the parent), so such a value would leave its segment.
        if !used.empty? && ['', '.', '..'].include?(output)
          raise ArgumentError, "path parameter #{used.join(', ')} must not serialize to an empty, \".\" or \"..\" path segment"
        end

        output
      end.join('/')
    end

    # The query string without '?' ("" when empty).
    def query(specs, values) = collect(specs, :query, values).join('&')

    # The cookie header value ("" when empty): the form style with values percent-encoded, pairs joined by "; ".
    def cookie(specs, values) = collect(specs, :cookie, values).join('; ')

    # The simple style without percent-encoding (header values are not URL-encoded); nil for null.
    def header(spec, value)
      parts =
        case value
        when nil then return nil
        when Array then present(value).map { |item| Json.scalar_text(item) }
        when Hash
          present_entries(value).flat_map do |key, item|
            spec.explode ? ["#{key}=#{Json.scalar_text(item)}"] : [key, Json.scalar_text(item)]
          end
        else [Json.scalar_text(value)]
        end
      text = parts.join(',')
      raise ArgumentError, "header #{spec.name.inspect}: values must not contain CR or LF" if text.match?(/[\r\n]/)

      text
    end

    def present(array) = array.reject(&:nil?)
    def present_entries(hash) = hash.reject { |_, item| item.nil? }

    def path_value(spec, value)
      # allowReserved only applies to query parameters; in a path it would let '/' '?' '#' escape the segment.
      enc = ->(text) { Percent.component(text) }
      name = enc.(spec.name)
      explode = spec.explode
      items =
        case value
        when Array then present(value).map { |item| enc.(Json.scalar_text(item)) }
        when Hash
          present_entries(value).flat_map do |key, item|
            explode ? ["#{enc.(key)}=#{enc.(Json.scalar_text(item))}"] : [enc.(key), enc.(Json.scalar_text(item))]
          end
        else [enc.(Json.scalar_text(value))]
        end

      case spec.style
      when :label
        ".#{items.join(explode ? '.' : ',')}"
      when :matrix
        if !value.is_a?(Array) && !value.is_a?(Hash)
          items[0].empty? ? ";#{name}" : ";#{name}=#{items[0]}"
        elsif items.empty? then ";#{name}"
        elsif !explode then ";#{name}=#{items.join(',')}"
        elsif value.is_a?(Array) then items.map { |item| ";#{name}=#{item}" }.join
        else items.map { |item| ";#{item}" }.join
        end
      else
        items.join(',')
      end
    end

    def collect(specs, location, values)
      specs.select { |s| s.location == location && values.key?(location, s.name) }
           .flat_map { |s| form_pairs(s, values.get(location, s.name)) }
    end

    # One form-family parameter as already-encoded `name=value` strings.
    def form_pairs(spec, value)
      reserved = spec.location == :query && spec.allow_reserved
      enc = reserved ? ->(text) { Percent.reserved(text) } : ->(text) { Percent.component(text) }
      name = enc.(spec.name)
      explode = spec.explode

      if spec.style == :deep_object && value.is_a?(Hash)
        pairs = []
        deep_object(name, value, enc, pairs)
        return pairs
      end

      # Exploded delimited styles are defined to behave like exploded form.
      separator =
        if !explode && spec.style == :space_delimited then '%20'
        elsif !explode && spec.style == :pipe_delimited then '|'
        else ','
        end

      case value
      when Array
        encoded = present(value).map { |item| enc.(Json.scalar_text(item)) }
        explode ? encoded.map { |item| "#{name}=#{item}" } : ["#{name}=#{encoded.join(separator)}"]
      when Hash
        entries = present_entries(value).map { |key, item| [enc.(key), enc.(Json.scalar_text(item))] }
        explode ? entries.map { |key, item| "#{key}=#{item}" } : ["#{name}=#{entries.flatten.join(separator)}"]
      else
        ["#{name}=#{enc.(Json.scalar_text(value))}"]
      end
    end

    def deep_object(prefix, value, enc, output)
      case value
      when Hash then present_entries(value).each { |key, item| deep_object("#{prefix}[#{enc.(key)}]", item, enc, output) }
      when Array then present(value).each { |item| deep_object(prefix, item, enc, output) }
      else output << "#{prefix}=#{enc.(Json.scalar_text(value))}"
      end
    end

    private_class_method :present, :present_entries, :path_value, :collect, :form_pairs, :deep_object
  end
end
