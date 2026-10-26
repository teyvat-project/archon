# frozen_string_literal: true

module Archon::Core
  # The content of a binary body or a multipart file part. Inside JSON it is a base64 string (the file name and
  # the content type are not part of JSON). The content is held in memory so a request can be sent again
  # (redirects, retries).
  class Upload
    attr_reader :content, :filename, :content_type

    # `content` is a String of bytes; `filename` is the multipart file name ("blob" when nil) and `content_type` the
    # part's Content-Type (application/octet-stream when nil; a binary body uses it only when the operation
    # declares no media type).
    def initialize(content, filename: nil, content_type: nil)
      @content = content.to_s.b.freeze
      @filename = filename
      @content_type = content_type
    end

    # Reads a file; the file name is its base name.
    def self.from_path(path, filename: nil, content_type: nil)
      new(::File.binread(path), filename: filename || ::File.basename(path), content_type: content_type)
    end

    # Reads an IO to its end.
    def self.from_io(io, filename: nil, content_type: nil)
      new(io.read.to_s, filename: filename, content_type: content_type)
    end

    # A JSON base64 string as an Upload.
    def self.from_base64(text)
      new(text.unpack1('m0'))
    rescue ArgumentError
      raise DecodeError, 'invalid base64 file content'
    end

    def size = content.bytesize

    def ==(other)
      other.is_a?(Upload) && content == other.content && filename == other.filename && content_type == other.content_type
    end
    alias eql? ==

    def hash = [content, filename, content_type].hash

    def inspect = "#<#{self.class.name} #{filename.inspect} (#{size} bytes)>"
  end
end
