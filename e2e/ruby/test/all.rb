# frozen_string_literal: true

# Runs every *_test.rb; started by `pnpm test:e2e:ruby` (scripts/run.mjs), which also starts the mock server.
Dir[File.join(__dir__, '*_test.rb')].sort.each { |file| require file }
