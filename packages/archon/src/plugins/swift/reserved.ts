/** Swift keywords that need backticks to be used as identifiers. */
export const SWIFT_KEYWORDS: Set<string> = new Set([
  'associatedtype', 'borrowing', 'class', 'consuming', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import',
  'init', 'inout', 'internal', 'let', 'nonisolated', 'open', 'operator', 'private', 'precedencegroup', 'protocol',
  'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'catch', 'continue',
  'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw', 'switch',
  'where', 'while', 'Any', 'as', 'await', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws', 'true', 'try', '_',
]);

/** Type names Swift does not let a declaration take (even with backticks, or not usefully). */
export const UNDECLARABLE_TYPES: string[] = ['Type', 'Self', 'Protocol', 'Any', 'AnyObject', 'Sendable'];

/** Modules generated code qualifies names with; a type of the same name would break the qualification. */
export const MODULE_NAMES: string[] = ['Swift', 'Foundation', 'FoundationNetworking', 'Dispatch', '_Concurrency'];

/** Standard library / Foundation types generated code refers to, by the module that declares them. */
export const STANDARD_TYPES: Record<string, 'Swift' | 'Foundation'> = {
  String: 'Swift',
  Int: 'Swift',
  Int32: 'Swift',
  Int64: 'Swift',
  Double: 'Swift',
  Float: 'Swift',
  Bool: 'Swift',
  Void: 'Swift',
  Codable: 'Swift',
  Hashable: 'Swift',
  CaseIterable: 'Swift',
  RawRepresentable: 'Swift',
  Decoder: 'Swift',
  Encoder: 'Swift',
  CodingKey: 'Swift',
  Hasher: 'Swift',
  Date: 'Foundation',
  Data: 'Foundation',
  UUID: 'Foundation',
};

/**
 * Member names a model property must not take: `hashValue` (Hashable), the extension-data property, and names that
 * cannot sensibly be stored properties even with backticks.
 */
export const RESERVED_PROPERTIES: string[] = ['hashValue', 'additionalProperties', 'init', 'self', 'Self', 'super', 'Type', 'Protocol'];

/** Members of a generated enum that a case must not take. */
export const RESERVED_CASES: string[] = ['unknown', 'rawValue', 'allCases', 'isKnown', 'init', 'self', 'Self', 'hashValue', 'Type'];
