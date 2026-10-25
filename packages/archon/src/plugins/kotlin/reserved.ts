/** Kotlin hard keywords (soft keywords and modifiers are valid identifiers). */
export const KT_KEYWORDS: Set<string> = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object',
  'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
]);

/**
 * Default-imported names the generated code uses. Services import `<pkg>.models.*`, and a star import wins over the
 * default imports, so a model may not take one of these names.
 */
export const BUILTIN_TYPES: string[] = [
  'Any', 'Boolean', 'Byte', 'ByteArray', 'Char', 'Double', 'Float', 'Int', 'List', 'Long', 'Map', 'Nothing', 'Number', 'Short',
  'String', 'Unit', 'Deprecated', 'Suppress', 'OptIn', 'IllegalArgumentException',
  // Inside a class, `Companion` names its companion object.
  'Companion',
];

/** Names the generated code imports explicitly (an explicit import would hide a model of the same name). */
export const IMPORTED_NAMES: string[] = [
  'Serializable', 'SerialName', 'EncodeDefault', 'KSerializer', 'Json', 'JsonElement', 'JsonObject', 'JsonPrimitive', 'JsonArray',
  'JsonNull', 'JsonDecoder', 'JsonEncoder', 'SerialDescriptor', 'PrimitiveSerialDescriptor', 'PrimitiveKind', 'Encoder', 'Decoder',
  'SerializationException', 'ExperimentalSerializationApi', 'ListSerializer', 'MapSerializer', 'HttpMethod', 'HttpClient',
];
