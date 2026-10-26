# frozen_string_literal: true

module Archon::Core
  # URL helpers that keep the exact bytes of paths and queries (no parser re-encodes or reorders them).
  module Url
    # An RFC 3986 reference split into its components; nil means the component is absent.
    Parts = Struct.new(:scheme, :authority, :path, :query, :fragment) do
      def to_s
        out = +''
        out << "#{scheme}:" if scheme
        out << "//#{authority}" if authority
        out << path
        out << "?#{query}" if query
        out << "##{fragment}" if fragment
        out
      end
    end

    # RFC 3986 appendix B.
    REFERENCE = %r{\A(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?\z}m
    private_constant :REFERENCE

    module_function

    def split(raw)
      m = REFERENCE.match(raw.to_s)
      Parts.new(m[1], m[2], m[3] || '', m[4], m[5])
    end

    # Whether `raw` is an absolute http(s) URL.
    def absolute?(raw)
      parts = split(raw)
      !parts.authority.to_s.empty? && %w[http https].include?(parts.scheme.to_s.downcase)
    end

    # Raises ArgumentError when `raw` is not an absolute http(s) URL.
    def require_absolute!(raw)
      return if absolute?(raw)

      raise ArgumentError, "#{raw.inspect} is not an absolute http(s) URL; pass an absolute base URL (e.g. \"https://api.example.com\")"
    end

    # Resolves a (possibly relative) reference against `base` (RFC 3986 §5.2), keeping the bytes of both.
    def resolve(base, location)
      b = split(base)
      r = split(location)
      target =
        if r.scheme
          r.dup.tap { |t| t.path = remove_dot_segments(r.path) }
        elsif r.authority
          r.dup.tap do |t|
            t.scheme = b.scheme
            t.path = remove_dot_segments(r.path)
          end
        elsif r.path.empty?
          b.dup.tap do |t|
            t.query = r.query if r.query
            t.fragment = r.fragment
          end
        else
          merged =
            if r.path.start_with?('/') then r.path
            elsif b.authority && b.path.empty? then "/#{r.path}"
            elsif (i = b.path.rindex('/')) then "#{b.path[0..i]}#{r.path}"
            else "/#{r.path}"
            end
          b.dup.tap do |t|
            t.path = remove_dot_segments(merged)
            t.query = r.query
            t.fragment = r.fragment
          end
        end
      target.to_s
    end

    # scheme://host:port, lower-cased, with the default port made explicit.
    def origin(raw)
      parts = split(raw)
      scheme = parts.scheme.to_s.downcase
      host_port = parts.authority.to_s.downcase.split('@').last.to_s
      host = host_port
      port = ''
      if (m = /:(\d*)\z/.match(host_port))
        host = m.pre_match
        port = m[1]
      end
      port = scheme == 'https' ? '443' : '80' if port.empty?
      "#{scheme}://#{host}:#{port}"
    end

    # `raw` without the query parameters named `names` (compared after decoding, case-sensitively).
    def without_query(raw, names)
      parts = split(raw)
      return raw if names.empty? || parts.query.nil?

      kept = query_pairs(parts.query).reject { |pair| names.include?(decode_name(pair)) }
      parts.query = kept.empty? ? nil : kept.join('&')
      parts.to_s
    end

    def query_pairs(query)
      query.nil? ? [] : query.split('&').reject(&:empty?)
    end

    # The decoded name of a `name=value` pair (`+` is a space); undecodable names are returned as written.
    def decode_name(pair)
      raw = pair.split('=', 2).first.to_s
      URI.decode_www_form_component(raw)
    rescue ArgumentError
      raw.tr('+', ' ')
    end

    def remove_dot_segments(path)
      return path unless path.include?('.')

      input = path.split('/', -1)
      output = []
      input.each_with_index do |segment, i|
        last = i == input.length - 1
        case segment
        when '.'
          output << '' if last
        when '..'
          output.pop if output.length > 1
          output << '' if last
        else
          output << segment
        end
      end
      output.join('/')
    end
  end
end
