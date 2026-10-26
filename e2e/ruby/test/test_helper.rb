# frozen_string_literal: true

# End-to-end tests of the generated Ruby SDK against e2e/mock-server; run with `pnpm test:e2e:ruby`.
require 'minitest/autorun'
require 'json'
require 'net/http'
require 'edge_cases'

BASE_URL = ENV.fetch('ARCHON_E2E_BASE_URL') do
  abort 'ARCHON_E2E_BASE_URL / ARCHON_E2E_SECONDARY_URL are not set; run the suite with `pnpm test:e2e:ruby`.'
end
SECONDARY_URL = ENV.fetch('ARCHON_E2E_SECONDARY_URL')

module E2E
  Core = EdgeCases::Core

  # A client for the mock server.
  def client(**options) = EdgeCases::Client.new(base_url: BASE_URL, **options)

  # The mock server's counters: tokens issued and requests per raw path.
  def stats = JSON.parse(Net::HTTP.get(URI("#{BASE_URL}/__stats")))
  def requests(path) = stats.fetch('requests')[path].to_i
  def tokens_issued = stats.fetch('tokensIssued')

  def unique_key(prefix) = "#{prefix}-#{Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)}"
end
