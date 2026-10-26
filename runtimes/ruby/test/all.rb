# frozen_string_literal: true

# Runs the runtime's whole suite: `ruby -w -Iruntimes/ruby/test runtimes/ruby/test/all.rb`.
Dir[File.join(__dir__, '*_test.rb')].sort.each { |file| require file }
