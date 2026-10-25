use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::base64;

/// File content for binary and multipart bodies. Inside JSON it is a base64 string.
#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct ApiFile {
    pub content: Vec<u8>,
    /// The multipart `filename` (`"blob"` when `None`).
    pub file_name: Option<String>,
    /// The multipart part's Content-Type (`application/octet-stream` when `None`); a binary body uses it only when
    /// the operation has no media type.
    pub content_type: Option<String>,
}

impl ApiFile {
    pub fn new(content: impl Into<Vec<u8>>) -> Self {
        Self { content: content.into(), file_name: None, content_type: None }
    }

    pub fn with_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.file_name = Some(file_name.into());
        self
    }

    pub fn with_content_type(mut self, content_type: impl Into<String>) -> Self {
        self.content_type = Some(content_type.into());
        self
    }
}

impl From<Vec<u8>> for ApiFile {
    fn from(content: Vec<u8>) -> Self {
        Self::new(content)
    }
}

impl From<&[u8]> for ApiFile {
    fn from(content: &[u8]) -> Self {
        Self::new(content)
    }
}

impl fmt::Debug for ApiFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiFile")
            .field("content", &format_args!("{} bytes", self.content.len()))
            .field("file_name", &self.file_name)
            .field("content_type", &self.content_type)
            .finish()
    }
}

/// Writes the content as a base64 string (the file name and type are not part of JSON).
impl Serialize for ApiFile {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::encode(&self.content))
    }
}

impl<'de> Deserialize<'de> for ApiFile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let content = base64::decode(&text).ok_or_else(|| D::Error::custom("invalid base64 file content"))?;
        Ok(ApiFile::new(content))
    }
}
