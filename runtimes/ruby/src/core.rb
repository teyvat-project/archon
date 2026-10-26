# frozen_string_literal: true

require 'date'
require 'json'
require 'net/http'
require 'securerandom'
require 'time'

# The runtime of an Archon-generated Ruby SDK: request building, parameter serialization, models, transport,
# authentication, middleware and errors. It only depends on the standard library.
module Archon::Core
end

require_relative 'core/errors'
require_relative 'core/specs'
require_relative 'core/headers'
require_relative 'core/json'
require_relative 'core/percent'
require_relative 'core/url'
require_relative 'core/params'
require_relative 'core/upload'
require_relative 'core/body'
require_relative 'core/values'
require_relative 'core/types'
require_relative 'core/model'
require_relative 'core/request'
require_relative 'core/transport'
require_relative 'core/auth'
require_relative 'core/oauth2'
require_relative 'core/client'
require_relative 'core/middleware'
