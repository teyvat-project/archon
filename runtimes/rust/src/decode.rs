use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::errors::DecodeError;

/// JSON through serde. 204 / 205 / 304 and empty bodies decode as JSON `null`: `Option<T>` becomes `None`, other
/// types fail with a [`DecodeError`].
pub fn decode_json<T: DeserializeOwned>(status: u16, body: &[u8]) -> Result<T, DecodeError> {
    if matches!(status, 204 | 205 | 304) || body.is_empty() {
        return serde_json::from_value(Value::Null).map_err(|_| {
            DecodeError::new(status, "", format!("Expected a JSON body but the response (HTTP {status}) is empty."))
        });
    }
    serde_json::from_slice(body).map_err(|e| {
        DecodeError::new(status, String::from_utf8_lossy(body), format!("Failed to parse JSON response: {e}")).with_source(e)
    })
}

/// The body as UTF-8 text (invalid sequences replaced).
pub fn decode_text(_status: u16, body: &[u8]) -> Result<String, DecodeError> {
    Ok(String::from_utf8_lossy(body).into_owned())
}

/// The raw bytes.
pub fn decode_binary(_status: u16, body: &[u8]) -> Result<Vec<u8>, DecodeError> {
    Ok(body.to_vec())
}

/// Ignores the body (operations without response content).
pub fn decode_empty(_status: u16, _body: &[u8]) -> Result<(), DecodeError> {
    Ok(())
}

/// The typed error body of an operation, decoded by status (`()` for operations that declare none).
pub trait ErrorBody: Sized {
    /// The body for `status`; `None` when the status declares none or the body does not decode.
    fn decode(status: u16, body: &[u8]) -> Option<Self>;
}

impl ErrorBody for () {
    fn decode(_status: u16, _body: &[u8]) -> Option<Self> {
        None
    }
}

/// A JSON error body; `None` when it is empty or not that JSON.
pub fn decode_error_json<T: DeserializeOwned>(body: &[u8]) -> Option<T> {
    if body.is_empty() {
        return None;
    }
    serde_json::from_slice(body).ok()
}

/// A text error body (`""` when empty).
pub fn decode_error_text(body: &[u8]) -> String {
    String::from_utf8_lossy(body).into_owned()
}
