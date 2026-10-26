# frozen_string_literal: true

require 'minitest/autorun'
require 'socket'

module Archon; end
require_relative '../src/core'

# A tiny HTTP/1.1 server recording each request as received (the raw target and headers, the body bytes) and
# answering with what the handler returns: [status, headers, body].
class TestServer
  Recorded = Struct.new(:http_method, :target, :headers, :body) do
    def header(name) = headers[name.downcase]&.first
  end

  attr_reader :url

  def initialize(&handler)
    @handler = handler || ->(_) { [200, {}, ''] }
    @server = TCPServer.new('127.0.0.1', 0)
    @url = "http://127.0.0.1:#{@server.addr[1]}"
    @requests = []
    @mutex = Mutex.new
    @thread = Thread.new do
      loop do
        socket = @server.accept
        Thread.new(socket) { |s| serve(s) }
      end
    rescue IOError, Errno::EBADF
      nil
    end
  end

  def requests = @mutex.synchronize { @requests.dup }
  def last = requests.last

  def close
    @server.close
    @thread.join(1)
  end

  private

  def serve(socket)
    line = socket.gets or return
    http_method, target = line.split(' ', 3)
    headers = Hash.new { |h, k| h[k] = [] }
    while (header = socket.gets) && header != "\r\n"
      name, value = header.chomp.split(':', 2)
      headers[name.downcase] << value.strip
    end
    body = +''.b
    if (length = headers['content-length'].first)
      body << socket.read(length.to_i)
    elsif headers['transfer-encoding'].first == 'chunked'
      while (size = socket.gets.to_i(16)).positive?
        body << socket.read(size)
        socket.read(2)
      end
      socket.read(2)
    end
    recorded = Recorded.new(http_method, target, headers, body)
    @mutex.synchronize { @requests << recorded }
    status, response_headers, response_body = @handler.call(recorded)
    response_body = response_body.to_s.b
    out = +"HTTP/1.1 #{status} Status\r\n"
    response_headers.each { |name, value| Array(value).each { |v| out << "#{name}: #{v}\r\n" } }
    out << "Content-Length: #{response_body.bytesize}\r\nConnection: close\r\n\r\n"
    socket.write(out.b + response_body)
  rescue IOError, SystemCallError
    nil
  ensure
    socket.close
  end
end

module RuntimeTest
  Core = Archon::Core

  def json(status, value, headers = {}) = [status, { 'Content-Type' => 'application/json' }.merge(headers), Core::Json.generate(value)]

  def spec(name, location, style = nil, explode: nil, allow_reserved: false)
    style ||= { path: :simple, query: :form, header: :simple, cookie: :form }.fetch(location)
    explode = %i[form].include?(style) if explode.nil?
    Core::ParamSpec.new(name: name, location: location, style: style, explode: explode, allow_reserved: allow_reserved)
  end

  def values = Core::Values.new
end
