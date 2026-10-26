import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUBY_VERSION } from '../../../src/plugins/ruby/project.js';
import { readRubyRuntime } from '../../../src/plugins/ruby/runtime.js';
import { doc, file, generate, obj, operation, prop, response, str } from './helpers.js';

const repoRuntime = fileURLToPath(new URL('../../../../../runtimes/ruby/src', import.meta.url));

function withAuth() {
  return doc({ Options: obj([prop('a', str)]) }, [
    operation('GET /a', 'getA', { group: 'catalyst', responses: [response(204)] }),
    operation('GET /b', 'getB', { group: 'use', responses: [response(204)] }),
  ], {
    info: { title: 'Natsuneko Laboratory API', version: '2026.10.23', description: 'The API.' },
    servers: [{ url: 'https://{env}.api.test:{port}/v1', variables: { env: { default: 'prod' }, port: { default: '8443' } } }],
    securitySchemes: new Map([
      ['bearerAuth', { kind: 'http-bearer' }],
      ['basic', { kind: 'http-basic' }],
      ['apiKey', { kind: 'apiKey', in: 'query', name: 'api_key' }],
      ['oauth2', { kind: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} }, authorizationCode: { refreshUrl: '/oauth/refresh', scopes: {} } } }],
      ['oidc', { kind: 'openIdConnect', url: 'https://id.test/.well-known' }],
      ['digest', { kind: 'http-other', scheme: 'digest' }],
      ['class', { kind: 'http-bearer' }],
    ]),
  });
}

describe('ruby plugin: client, auth, entry, gemspec and runtime', () => {
  it('emits the client with the default base URL, the scheme table and a reader per service', async () => {
    const { files } = await generate(withAuth(), { gemName: undefined });
    const client = file(files, 'lib/natsuneko_laboratory_api/client.rb');
    expect(client).toContain('module NatsunekoLaboratoryApi\n  # The client for Natsuneko Laboratory API. It is safe to share between threads.\n  class Client\n');
    expect(client).toContain("    DEFAULT_BASE_URL = 'https://prod.api.test:8443/v1'\n");
    expect(client).toContain("      'bearerAuth' => Core::SecuritySchemeSpec.new(kind: :http_bearer),\n");
    expect(client).toContain("      'apiKey' => Core::SecuritySchemeSpec.new(kind: :api_key, location: :query, name: 'api_key'),\n");
    expect(client).toContain("      'oauth2' => Core::SecuritySchemeSpec.new(kind: :oauth2, token_url: '/oauth/token', refresh_url: '/oauth/refresh'),\n");
    expect(client).toContain("      'oidc' => Core::SecuritySchemeSpec.new(kind: :open_id_connect),\n      'class' => Core::SecuritySchemeSpec.new(kind: :http_bearer),\n    }.freeze\n");
    expect(client).not.toContain('digest');
    expect(client).toContain('    attr_reader :catalyst\n    # @return [UseService]\n    attr_reader :use_\n');
    expect(client).toContain('    def initialize(base_url: nil, auth: nil, headers: {}, timeout: nil, middleware: [], transport: nil, custom_auth: nil)\n');
    expect(client).toContain('        base_url: base_url || DEFAULT_BASE_URL, security_schemes: SECURITY_SCHEMES,');
    expect(client).toContain('      @catalyst = CatalystService.new(@core)\n      @use_ = UseService.new(@core)\n');
    expect(client).toContain('    def use(middleware = nil, &block)\n      @core.use(middleware, &block)\n      self\n    end\n');
  });

  it('emits Auth with an accessor per scheme', async () => {
    const auth = file((await generate(withAuth())).files, 'lib/api/auth.rb');
    expect(auth).toContain('    attr_accessor :bearer_auth\n');
    expect(auth).toContain('    attr_accessor :class_\n');
    expect(auth).toContain('    def initialize(bearer_auth: nil, basic: nil, api_key: nil, oauth2: nil, oidc: nil, class_: nil)\n      @bearer_auth = bearer_auth\n');
    expect(auth).toContain("      case scheme.to_s\n      when 'bearerAuth' then @bearer_auth\n");
    expect(auth).toContain("      when 'class' then @class_\n      end\n");
    expect(file((await generate(doc({}))).files, 'lib/api/auth.rb')).toContain('    def [](_scheme) = nil\n');
  });

  it('emits the entry file, the version and the gemspec (or none for package false)', async () => {
    const { files } = await generate(withAuth(), { moduleName: 'Acme::Api', package: { license: 'MIT', authors: ['Acme'] } });
    const entry = file(files, 'lib/api.rb');
    expect(entry).toContain('module Acme\n  module Api\n  end\nend\n\n');
    expect(entry).toContain("require_relative 'api/version'\nrequire_relative 'api/core'\nrequire_relative 'api/models/options'\n");
    expect(entry).toContain("require_relative 'api/services/catalyst'\nrequire_relative 'api/services/use'\nrequire_relative 'api/auth'\nrequire_relative 'api/client'\n");
    expect(entry).toContain('module Acme::Api\n  ApiError = Core::ApiError\n');
    expect(file(files, 'lib/api/version.rb')).toContain("module Acme::Api\n  # The version of this SDK.\n  VERSION = '2026.10.23'\nend\n");
    expect(file(files, 'api.gemspec')).toBe(
      [
        '# frozen_string_literal: true',
        '',
        '# Code generated by Archon. DO NOT EDIT.',
        '# Generated header',
        '',
        "require_relative 'lib/api/version'",
        '',
        'Gem::Specification.new do |spec|',
        "  spec.name = 'api'",
        '  spec.version = Acme::Api::VERSION',
        "  spec.summary = 'A client for Natsuneko Laboratory API'",
        "  spec.description = 'The API.'",
        "  spec.authors = ['Acme']",
        "  spec.license = 'MIT'",
        `  spec.required_ruby_version = '>= ${RUBY_VERSION}'`,
        "  spec.files = Dir['lib/**/*.rb', 'sig/**/*.rbs']",
        "  spec.require_paths = ['lib']",
        'end',
        '',
      ].join('\n'),
    );
    expect((await generate(withAuth(), { package: false })).files.has('api.gemspec')).toBe(false);
    const bad = await generate(doc({}, [], { info: { title: 'X', version: 'v1 beta' } }));
    expect(file(bad.files, 'lib/api/version.rb')).toContain("VERSION = '0.1.0'");
  });

  it('emits RBS for the client, the services and the models', async () => {
    const rbs = file((await generate(withAuth())).files, 'sig/api.rbs');
    expect(rbs).toContain('module Api\n  VERSION: ::String\n');
    expect(rbs).toContain('  ApiError: singleton(Core::ApiError)\n');
    expect(rbs).toContain('    attr_reader use_: UseService\n');
    expect(rbs).toContain('    attr_accessor bearer_auth: Core::token_credentials?\n    attr_accessor basic: Core::basic_credentials?\n');
    expect(rbs).toContain('    attr_accessor oauth2: Core::oauth2_credentials?\n');
    expect(rbs).toContain('    def get_a: (?request_options: Core::request_options) ?{ (Core::Response) -> void } -> nil\n');
    expect(rbs).toContain('  class Options < ::Data\n    include Core::Model\n    extend Core::Model::ClassMethods\n    attr_reader a: ::String?\n    def initialize: (?a: ::String?) -> void\n');
  });

  it('copies the runtime under core with its namespace replaced, and its RBS under sig', async () => {
    const { files } = await generate(withAuth(), { moduleName: 'Acme::Api' });
    const copied = [...files.keys()].filter((p) => p.startsWith('lib/api/core')).sort();
    const expected = ['core.rb', ...readdirSync(`${repoRuntime}/core`).filter((f) => f.endsWith('.rb')).map((f) => `core/${f}`)].sort();
    expect(copied).toEqual(expected.map((f) => `lib/api/${f}`));
    expect(readRubyRuntime(repoRuntime).map((f) => f.name).sort()).toEqual([...expected, 'core.rbs'].sort());
    const client = file(files, 'lib/api/core/client.rb');
    expect(client.startsWith('# frozen_string_literal: true\n\n# Code generated by Archon. DO NOT EDIT.\n# Generated header\n\nmodule Acme::Api::Core\n')).toBe(true);
    expect(file(files, 'lib/api/core.rb')).toContain('module Acme::Api::Core\nend\n');
    const sig = file(files, 'sig/api/core.rbs');
    expect(sig.startsWith('# Code generated by Archon. DO NOT EDIT.\n# Generated header\n\n')).toBe(true);
    expect(sig).toContain('module Acme::Api::Core\n');
    expect([...files.values()].some((content) => /\bArchon::Core\b/.test(content))).toBe(false);
  });

  it('keeps the minimum Ruby version in step with the runtime', () => {
    const ci = readFileSync(fileURLToPath(new URL('../../../../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    expect(ci).toContain(`ruby: ['${RUBY_VERSION}', ruby]`);
  });
});
