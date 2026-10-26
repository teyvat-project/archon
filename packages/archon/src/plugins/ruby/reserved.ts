/** Ruby keywords: a method, argument or member named like one gets a trailing `_`. */
export const RUBY_KEYWORDS: Set<string> = new Set([
  '__ENCODING__', '__FILE__', '__LINE__', 'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do',
  'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry',
  'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield',
]);

/**
 * Methods of Object, Kernel, Data and Core::Model that a model member, a service method or a client reader must not
 * replace (they also get a trailing `_`).
 */
export const OBJECT_METHODS: Set<string> = new Set([
  'as_json', 'class', 'clone', 'deconstruct', 'deconstruct_keys', 'define_singleton_method', 'display', 'dup', 'enum_for', 'extend',
  'freeze', 'hash', 'initialize', 'initialize_copy', 'inspect', 'instance_variable_get', 'instance_variable_set', 'instance_variables',
  'itself', 'members', 'method', 'methods', 'object_id', 'public_send', 'send', 'singleton_class', 'singleton_method', 'tap', 'then',
  'to_enum', 'to_h', 'to_json', 'to_s', 'with', 'yield_self',
]);

/** Constants the generated SDK module declares itself (schemas must not take them). */
export const MODULE_CONSTANTS: string[] = ['Core', 'Client', 'Auth', 'VERSION', 'ApiError', 'TransportError', 'TimeoutError', 'DecodeError', 'AuthError'];

/** Locals and arguments of a generated operation method that parameters must not take. */
export const OPERATION_LOCALS: string[] = ['body', 'request_options', 'on_response', 'values'];

/** Members of the generated Client that a service reader must not take. */
export const CLIENT_MEMBERS: string[] = ['core', 'use'];
