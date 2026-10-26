# frozen_string_literal: true

module Archon::Core
  # A request body. `open` is called once per send and returns the content (a String, or an IO for streamed
  # bodies) and its length (nil when unknown), so a replayable body can be sent again (redirects, retries).
  # `content_type` is the Content-Type to send (nil for none).
  class Body
    def replayable? = true
    def content_type = nil

    def open
      raise NotImplementedError
    end
  end

  # A buffered body.
  class BytesBody < Body
    attr_reader :content, :content_type

    def initialize(content, content_type = nil)
      super()
      @content = content.to_s.b.freeze
      @content_type = content_type
    end

    def open = [content, content.bytesize]
  end

  # A streamed body: sent once and never again (a redirect that needs the body again is returned as is, and
  # retrying middleware does not re-send it).
  class IOBody < Body
    attr_reader :content_type

    def initialize(io, content_type = nil, length: nil)
      super()
      @io = io
      @content_type = content_type
      @length = length
      @used = false
      @mutex = Mutex.new
    end

    def replayable? = false

    def open
      @mutex.synchronize do
        raise ArgumentError, 'an IOBody can only be sent once' if @used

        @used = true
      end
      [@io, @length]
    end
  end

  # An application/x-www-form-urlencoded body, encoded the way URLSearchParams does.
  class FormBody < Body
    attr_reader :fields

    def initialize
      super
      @fields = []
    end

    # A form from a JSON object: arrays become repeated names, objects JSON text, nils are skipped.
    def self.from_json(object)
      form = new
      object.each { |name, value| field_values(value).each { |text| form.add(name, text) } }
      form
    end

    # A JSON value as form / multipart field values: arrays become one value per item, nils are skipped, objects
    # are JSON text.
    def self.field_values(value)
      (value.is_a?(Array) ? value : [value]).reject(&:nil?).map { |item| Json.scalar_text(item) }
    end

    def add(name, value)
      @fields << [name.to_s, value.to_s]
      self
    end

    def content_type = 'application/x-www-form-urlencoded'

    def encode = fields.map { |name, value| "#{Percent.form(name)}=#{Percent.form(value)}" }.join('&')

    def open
      text = encode
      [text, text.bytesize]
    end
  end

  # A multipart/form-data body. The boundary is fixed per instance, so every send produces the same bytes.
  class MultipartBody < Body
    attr_reader :boundary

    def initialize
      super
      @parts = []
      @boundary = "archon-#{SecureRandom.hex(12)}"
    end

    # Adds a text part.
    def text(name, value)
      @parts << [name.to_s, value.to_s, nil]
      self
    end

    # Adds text parts for a value: strings unquoted, numbers and booleans as written, arrays as repeated parts,
    # objects as JSON text; nil adds nothing.
    def field(name, value)
      FormBody.field_values(Json.encode(value)).each { |text| text(name, text) }
      self
    end

    # Adds a file part (an Upload, or a String of bytes); nil adds nothing.
    def file(name, upload)
      return self if upload.nil?

      upload = Upload.new(upload) unless upload.is_a?(Upload)
      @parts << [name.to_s, nil, upload]
      self
    end

    # Adds one file part per upload.
    def files(name, uploads)
      Array(uploads).each { |upload| file(name, upload) }
      self
    end

    def content_type = "multipart/form-data; boundary=#{boundary}"

    def open
      out = +''.b
      @parts.each do |name, text, upload|
        out << "--#{boundary}\r\n"
        # filename* is not written: some servers reject it.
        if upload.nil?
          out << "Content-Disposition: form-data; name=\"#{quote(name)}\"\r\n\r\n"
          out << Json.utf8(text).b
        else
          out << "Content-Disposition: form-data; name=\"#{quote(name)}\"; filename=\"#{quote(upload.filename || 'blob')}\"\r\n"
          out << "Content-Type: #{upload.content_type || 'application/octet-stream'}\r\n\r\n"
          out << upload.content
        end
        out << "\r\n"
      end
      out << "--#{boundary}--\r\n"
      [out, out.bytesize]
    end

    private

    # Escapes a disposition value the way browsers do (`"` and line breaks are percent-encoded).
    def quote(value) = Json.utf8(value.to_s).gsub('"', '%22').gsub("\r", '%0D').gsub("\n", '%0A').b
  end
end
