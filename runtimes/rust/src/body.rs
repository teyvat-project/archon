use std::collections::hash_map::RandomState;
use std::fmt;
use std::hash::{BuildHasher, Hasher};

use serde::Serialize;
use serde_json::Value;

use crate::encoding;
use crate::file::ApiFile;
use crate::params::text;

/// A request body. Buffered bytes can be sent again (redirects, retries); a stream is sent once.
pub enum ApiBody {
    Bytes(Vec<u8>),
    /// A streamed body: never re-sent (a redirect that needs the body again is returned as is).
    Stream(reqwest::Body),
}

impl ApiBody {
    /// Whether the body can be sent more than once.
    pub fn replayable(&self) -> bool {
        matches!(self, ApiBody::Bytes(_))
    }

    /// A copy for another send; `None` for a stream.
    pub fn try_clone(&self) -> Option<ApiBody> {
        match self {
            ApiBody::Bytes(bytes) => Some(ApiBody::Bytes(bytes.clone())),
            ApiBody::Stream(_) => None,
        }
    }

    /// The bytes of a buffered body.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            ApiBody::Bytes(bytes) => Some(bytes),
            ApiBody::Stream(_) => None,
        }
    }
}

impl fmt::Debug for ApiBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiBody::Bytes(bytes) => write!(f, "Bytes({} bytes)", bytes.len()),
            ApiBody::Stream(_) => f.write_str("Stream"),
        }
    }
}

impl From<Vec<u8>> for ApiBody {
    fn from(bytes: Vec<u8>) -> Self {
        ApiBody::Bytes(bytes)
    }
}

impl From<String> for ApiBody {
    fn from(text: String) -> Self {
        ApiBody::Bytes(text.into_bytes())
    }
}

/// The text of a JSON value as a form field: strings unquoted, numbers as JavaScript prints them, objects as JSON.
fn field_text(value: &Value) -> String {
    if value.is_object() {
        value.to_string()
    } else {
        text(value)
    }
}

/// A JSON value as field values: arrays become one value per item, nulls are skipped.
fn field_values(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter(|v| !v.is_null()).map(field_text).collect(),
        Value::Null => Vec::new(),
        other => vec![field_text(other)],
    }
}

/// An `application/x-www-form-urlencoded` body, encoded the way `URLSearchParams` does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FormBody {
    fields: Vec<(String, String)>,
}

impl FormBody {
    pub const CONTENT_TYPE: &'static str = "application/x-www-form-urlencoded";

    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.push((name.into(), value.into()));
        self
    }

    /// Fields from a JSON object: arrays become repeated names, objects JSON text, nulls are skipped.
    pub fn from_json(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let mut body = FormBody::new();
        for (name, value) in map {
            for text in field_values(value) {
                body.fields.push((name.clone(), text));
            }
        }
        Some(body)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.fields
            .iter()
            .map(|(n, v)| format!("{}={}", encoding::form(n), encoding::form(v)))
            .collect::<Vec<_>>()
            .join("&")
            .into_bytes()
    }
}

#[derive(Clone)]
enum Part {
    Text(String, String),
    File(String, ApiFile),
}

/// A `multipart/form-data` body. The boundary is fixed per instance, so every send produces the same bytes.
#[derive(Clone)]
pub struct MultipartBody {
    boundary: String,
    parts: Vec<Part>,
    error: Option<String>,
}

impl Default for MultipartBody {
    fn default() -> Self {
        Self::new()
    }
}

impl MultipartBody {
    pub fn new() -> Self {
        let state = RandomState::new();
        let mut boundary = String::from("archon-");
        for _ in 0..2 {
            let mut hasher = state.build_hasher();
            hasher.write_usize(boundary.len());
            boundary.push_str(&format!("{:012x}", hasher.finish() & 0xffff_ffff_ffff));
        }
        Self { boundary, parts: Vec::new(), error: None }
    }

    /// `multipart/form-data; boundary=…`.
    pub fn content_type(&self) -> String {
        format!("multipart/form-data; boundary={}", self.boundary)
    }

    /// Adds a text part.
    pub fn add_text(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.parts.push(Part::Text(name.into(), value.into()));
        self
    }

    /// Adds text parts for a value: strings unquoted, numbers and booleans as written, arrays as repeated parts,
    /// objects as JSON text; `None` / null adds nothing.
    pub fn add_json<T: Serialize + ?Sized>(mut self, name: &str, value: &T) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => {
                for text in field_values(&value) {
                    self.parts.push(Part::Text(name.to_owned(), text));
                }
            }
            Err(e) => {
                if self.error.is_none() {
                    self.error = Some(format!("Multipart field \"{name}\" cannot be serialized: {e}"));
                }
            }
        }
        self
    }

    /// Adds a file part; `None` adds nothing.
    pub fn add_file<'a>(mut self, name: &str, file: impl Into<Option<&'a ApiFile>>) -> Self {
        if let Some(file) = file.into() {
            self.parts.push(Part::File(name.to_owned(), file.clone()));
        }
        self
    }

    /// Adds one file part per file.
    pub fn add_files<'a>(mut self, name: &str, files: impl IntoIterator<Item = &'a ApiFile>) -> Self {
        for file in files {
            self.parts.push(Part::File(name.to_owned(), file.clone()));
        }
        self
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for part in &self.parts {
            out.extend_from_slice(format!("--{}\r\n", self.boundary).as_bytes());
            // filename* is not written: some servers reject it.
            match part {
                Part::Text(name, value) => {
                    out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", quote(name)).as_bytes());
                    out.extend_from_slice(value.as_bytes());
                }
                Part::File(name, file) => {
                    let file_name = file.file_name.as_deref().unwrap_or("blob");
                    let content_type = file.content_type.as_deref().unwrap_or("application/octet-stream");
                    out.extend_from_slice(
                        format!(
                            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
                            quote(name),
                            quote(file_name)
                        )
                        .as_bytes(),
                    );
                    out.extend_from_slice(&file.content);
                }
            }
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        out
    }
}

impl fmt::Debug for MultipartBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MultipartBody").field("boundary", &self.boundary).field("parts", &self.parts.len()).finish()
    }
}

/// Escapes a disposition value the way browsers do (`"` and line breaks are percent-encoded).
fn quote(value: &str) -> String {
    value.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}
