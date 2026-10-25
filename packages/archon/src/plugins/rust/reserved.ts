/** Rust keywords (strict and reserved, edition 2021, plus `gen` from 2024): written as raw identifiers (`r#type`). */
export const RS_KEYWORDS: Set<string> = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if',
  'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct',
  'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'gen',
  'macro', 'override', 'priv', 'try', 'typeof', 'unsized', 'virtual', 'yield',
]);

/** Keywords that cannot be raw identifiers; they get a trailing `_` instead. */
export const NON_RAW: Set<string> = new Set(['crate', 'self', 'Self', 'super', '_']);

/**
 * Names in the Rust prelude the generated code uses unqualified (`String`, `Vec`, `Option`, `Box`, ...), and derive
 * macro names. A model of the same name would hide them in its own file, so model names avoid them.
 */
export const PRELUDE_NAMES: string[] = [
  'AsMut', 'AsRef', 'Box', 'Clone', 'Copy', 'Debug', 'Default', 'DoubleEndedIterator', 'Drop', 'Eq', 'Err', 'ExactSizeIterator',
  'Extend', 'Fn', 'FnMut', 'FnOnce', 'From', 'FromIterator', 'Hash', 'Into', 'IntoIterator', 'Iterator', 'None', 'Ok', 'Option',
  'Ord', 'PartialEq', 'PartialOrd', 'Result', 'Send', 'Sized', 'Some', 'String', 'Sync', 'ToOwned', 'ToString', 'TryFrom',
  'TryInto', 'Unpin', 'Vec', 'Self',
];

/** Crate and module names a generated module must not shadow. */
export const RESERVED_MODULES: string[] = ['core', 'std', 'alloc', 'serde', 'serde_json', 'reqwest', 'tokio', 'models', 'services', 'mod'];
