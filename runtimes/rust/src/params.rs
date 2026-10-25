//! OpenAPI `style` / `explode` serialization (RFC 6570), matching the TypeScript, C# and Kotlin runtimes.

use serde_json::{Map, Value};

use crate::encoding;
use crate::errors::InvalidRequestError;
use crate::json_number::format_number;
use crate::specs::{ParamLocation, ParamSpec, ParamStyle};
use crate::values::RequestValues;

/// Fills the `{name}` placeholders of `template` with the path parameters.
pub fn serialize_path(template: &str, specs: &[ParamSpec], values: &RequestValues) -> Result<String, InvalidRequestError> {
    // Serialized values never contain '/', so template segments map 1:1 onto URL path segments.
    let mut segments = Vec::new();
    for segment in template.split('/') {
        let mut output = String::new();
        let mut used = Vec::new();
        let mut rest = segment;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let close = match after.find(['{', '}']) {
                Some(i) if after.as_bytes()[i] == b'}' && i > 0 => i,
                _ => {
                    output.push_str(&rest[..=open]);
                    rest = after;
                    continue;
                }
            };
            let name = &after[..close];
            output.push_str(&rest[..open]);
            rest = &after[close + 1..];
            let Some(spec) = specs.iter().find(|s| s.location == ParamLocation::Path && s.name == name) else {
                output.push('{');
                output.push_str(name);
                output.push('}');
                continue;
            };
            let value = values
                .get(ParamLocation::Path, name)
                .ok_or_else(|| InvalidRequestError::new(format!("Missing required path parameter \"{name}\".")))?;
            used.push(name);
            output.push_str(&path_value(spec, value));
        }
        output.push_str(rest);
        // URL parsers drop '.' / '..' segments (and '..' pops the parent), so such a value would leave its segment.
        if !used.is_empty() && (output.is_empty() || output == "." || output == "..") {
            let names: Vec<String> = used.iter().map(|n| format!("\"{n}\"")).collect();
            return Err(InvalidRequestError::new(format!(
                "Path parameter {} must not serialize to an empty, \".\" or \"..\" path segment.",
                names.join(", ")
            )));
        }
        segments.push(output);
    }
    Ok(segments.join("/"))
}

/// The query string (without `?`; empty when no query parameter is set).
pub fn serialize_query(specs: &[ParamSpec], values: &RequestValues) -> String {
    collect(specs, ParamLocation::Query, values).join("&")
}

/// `simple` style without percent-encoding (header values are not URL-encoded); `None` for null.
pub fn serialize_header(spec: &ParamSpec, value: &Value) -> Result<Option<String>, InvalidRequestError> {
    fn raw(text: String) -> Result<String, InvalidRequestError> {
        if text.contains(['\r', '\n']) {
            return Err(InvalidRequestError::new("Header values must not contain CR or LF."));
        }
        Ok(text)
    }

    let text = match value {
        Value::Null => return Ok(None),
        Value::Array(items) => present(items).map(|v| raw(text(v))).collect::<Result<Vec<_>, _>>()?.join(","),
        Value::Object(map) => {
            let mut parts = Vec::new();
            for (k, v) in entries(map) {
                let (k, v) = (raw(k.clone())?, raw(text(v))?);
                parts.push(if spec.explode { format!("{k}={v}") } else { format!("{k},{v}") });
            }
            parts.join(",")
        }
        other => raw(text(other))?,
    };
    Ok(Some(text))
}

/// `form` style, values percent-encoded, pairs joined by `"; "`; `None` when no cookie parameter is set.
pub fn serialize_cookie(specs: &[ParamSpec], values: &RequestValues) -> Option<String> {
    let pairs = collect(specs, ParamLocation::Cookie, values);
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

/// The text of a scalar: strings unquoted, numbers as JavaScript prints them, booleans as `true` / `false`;
/// arrays and objects as JSON.
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => format_number(n),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

fn present(items: &[Value]) -> impl Iterator<Item = &Value> {
    items.iter().filter(|v| !v.is_null())
}

fn entries(map: &Map<String, Value>) -> impl Iterator<Item = (&String, &Value)> {
    map.iter().filter(|(_, v)| !v.is_null())
}

fn path_value(spec: &ParamSpec, value: &Value) -> String {
    // allowReserved only applies to query parameters; in a path it would let '/' '?' '#' escape the segment.
    let enc = encoding::component;
    let name = enc(spec.name);
    let explode = spec.explode;
    let is_array = value.is_array();
    let is_object = value.is_object();

    let items: Vec<String> = match value {
        Value::Array(items) => present(items).map(|v| enc(&text(v))).collect(),
        Value::Object(map) if explode => entries(map).map(|(k, v)| format!("{}={}", enc(k), enc(&text(v)))).collect(),
        Value::Object(map) => entries(map).flat_map(|(k, v)| [enc(k), enc(&text(v))]).collect(),
        other => vec![enc(&text(other))],
    };

    match spec.style {
        ParamStyle::Label => format!(".{}", items.join(if explode { "." } else { "," })),
        ParamStyle::Matrix => {
            if !is_array && !is_object {
                if items[0].is_empty() {
                    format!(";{name}")
                } else {
                    format!(";{name}={}", items[0])
                }
            } else if items.is_empty() {
                format!(";{name}")
            } else if !explode {
                format!(";{name}={}", items.join(","))
            } else if is_array {
                items.iter().map(|i| format!(";{name}={i}")).collect()
            } else {
                items.iter().map(|i| format!(";{i}")).collect()
            }
        }
        _ => items.join(","),
    }
}

fn collect(specs: &[ParamSpec], location: ParamLocation, values: &RequestValues) -> Vec<String> {
    let mut output = Vec::new();
    for spec in specs.iter().filter(|s| s.location == location) {
        if let Some(value) = values.get(location, spec.name) {
            output.extend(form_pairs(spec, value));
        }
    }
    output
}

/// One `form`-family parameter as already-encoded `name=value` strings.
fn form_pairs(spec: &ParamSpec, value: &Value) -> Vec<String> {
    let enc: fn(&str) -> String =
        if spec.location == ParamLocation::Query && spec.allow_reserved { encoding::reserved } else { encoding::component };
    let name = enc(spec.name);
    let explode = spec.explode;

    if let (ParamStyle::DeepObject, Value::Object(_)) = (spec.style, value) {
        let mut pairs = Vec::new();
        deep_object(&name, value, enc, &mut pairs);
        return pairs;
    }

    // Exploded delimited styles are defined to behave like exploded form.
    let separator = match spec.style {
        ParamStyle::SpaceDelimited if !explode => "%20",
        ParamStyle::PipeDelimited if !explode => "|",
        _ => ",",
    };

    match value {
        Value::Array(items) if explode => present(items).map(|v| format!("{name}={}", enc(&text(v)))).collect(),
        Value::Array(items) => {
            vec![format!("{name}={}", present(items).map(|v| enc(&text(v))).collect::<Vec<_>>().join(separator))]
        }
        Value::Object(map) if explode => entries(map).map(|(k, v)| format!("{}={}", enc(k), enc(&text(v)))).collect(),
        Value::Object(map) => {
            let flat: Vec<String> = entries(map).flat_map(|(k, v)| [enc(k), enc(&text(v))]).collect();
            vec![format!("{name}={}", flat.join(separator))]
        }
        other => vec![format!("{name}={}", enc(&text(other)))],
    }
}

fn deep_object(prefix: &str, value: &Value, enc: fn(&str) -> String, output: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in entries(map) {
                deep_object(&format!("{prefix}[{}]", enc(key)), child, enc, output);
            }
        }
        Value::Array(items) => {
            for child in present(items) {
                deep_object(prefix, child, enc, output);
            }
        }
        other => output.push(format!("{prefix}={}", enc(&text(other)))),
    }
}
