# frozen_string_literal: true

module Archon::Core
  # The parameter values and the body of one call. Values are converted to JSON (Json.encode), so models are
  # serialized by their wire names and nil values are not sent.
  class Values
    def initialize
      @params = {}
      @body = nil
    end

    def path(name, value) = add(:path, name, value)
    def query(name, value) = add(:query, name, value)
    def header(name, value) = add(:header, name, value)
    def cookie(name, value) = add(:cookie, name, value)

    def key?(location, name) = @params.key?([location, name])
    def get(location, name) = @params[[location, name]]

    # A JSON body.
    def json_body(value)
      data = Json.generate(value)
      @body = ->(media_type) { BytesBody.new(data, media_type || 'application/json') }
      self
    end

    # An application/x-www-form-urlencoded body from the JSON properties of a model or Hash (or a FormBody).
    def form_body(value)
      return body(value) if value.is_a?(FormBody)

      object = Json.encode(value)
      raise ArgumentError, 'a form body must be a JSON object (a model or a Hash)' unless object.is_a?(Hash)

      form = FormBody.from_json(object)
      @body = ->(_) { form }
      self
    end

    # A multipart/form-data body from a model or a Hash (or a MultipartBody): Uploads (and arrays of them) become
    # file parts, other values text parts (see MultipartBody#field); nils are skipped.
    def multipart_body(value)
      return body(value) if value.is_a?(MultipartBody)

      parts =
        case value
        when Model then value.class.json_fields.map { |field| [field.wire, value.public_send(field.name)] }
        when Hash then value.map { |name, item| [name.to_s, item] }
        else raise ArgumentError, 'a multipart body must be a model, a Hash or a MultipartBody'
        end
      multipart = MultipartBody.new
      parts.each do |name, item|
        if item.is_a?(Upload) || (item.is_a?(Array) && !item.empty? && item.all?(Upload))
          multipart.files(name, Array(item))
        else
          multipart.field(name, item)
        end
      end
      body(multipart)
    end

    # A text body.
    def text_body(value)
      text = Json.utf8(value.to_s)
      @body = ->(media_type) { BytesBody.new(text, media_type || 'text/plain') }
      self
    end

    # A raw body (an Upload, or a String of bytes), sent with the operation's media type (the upload's content type
    # when the operation has none).
    def binary_body(value)
      upload = value.is_a?(Upload) ? value : Upload.new(value)
      @body = ->(media_type) { BytesBody.new(upload.content, media_type || upload.content_type || 'application/octet-stream') }
      self
    end

    # A body built by hand (a MultipartBody, an IOBody, ...).
    def body(value)
      @body = ->(_) { value }
      self
    end

    # The body for the operation's media type, or nil.
    def body_for(media_type) = @body&.call(media_type)

    private

    def add(location, name, value)
      converted = Json.encode(value)
      @params[[location, name]] = converted unless converted.nil?
      self
    end
  end
end
