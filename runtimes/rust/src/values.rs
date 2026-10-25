use serde::Serialize;
use serde_json::Value;

use crate::body::{ApiBody, FormBody, MultipartBody};
use crate::errors::InvalidRequestError;
use crate::file::ApiFile;
use crate::specs::ParamLocation;

/// A body as set by the generated code; its bytes and Content-Type are decided with the operation's media type.
#[derive(Debug)]
pub(crate) enum PendingBody {
    Json(Vec<u8>),
    Form(FormBody),
    Multipart(MultipartBody),
    Text(String),
    Binary(ApiFile),
    Raw(ApiBody, Option<String>),
}

impl PendingBody {
    /// The body and its Content-Type for the operation's media type.
    pub(crate) fn resolve(self, media_type: Option<&str>) -> (ApiBody, Option<String>) {
        let media = media_type.map(str::to_owned);
        match self {
            PendingBody::Json(bytes) => (ApiBody::Bytes(bytes), Some(media.unwrap_or_else(|| "application/json".into()))),
            PendingBody::Form(form) => (ApiBody::Bytes(form.to_bytes()), Some(FormBody::CONTENT_TYPE.into())),
            PendingBody::Multipart(multipart) => {
                let content_type = multipart.content_type();
                (ApiBody::Bytes(multipart.to_bytes()), Some(content_type))
            }
            PendingBody::Text(text) => (ApiBody::Bytes(text.into_bytes()), Some(media.unwrap_or_else(|| "text/plain".into()))),
            PendingBody::Binary(file) => {
                let content_type = media.or(file.content_type).unwrap_or_else(|| "application/octet-stream".into());
                (ApiBody::Bytes(file.content), Some(content_type))
            }
            PendingBody::Raw(body, content_type) => (body, content_type),
        }
    }
}

/// The parameter values (and the body) of one call. Values are converted to JSON with serde, so the parameter
/// serializer sees struct fields in declaration order and enums as their raw values; `None` / null is "not set".
#[derive(Debug, Default)]
pub struct RequestValues {
    values: Vec<(ParamLocation, String, Value)>,
    body: Option<PendingBody>,
    error: Option<InvalidRequestError>,
}

impl RequestValues {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn path<T: Serialize + ?Sized>(self, name: &str, value: &T) -> Self {
        self.add(ParamLocation::Path, name, value)
    }

    pub fn query<T: Serialize + ?Sized>(self, name: &str, value: &T) -> Self {
        self.add(ParamLocation::Query, name, value)
    }

    pub fn header<T: Serialize + ?Sized>(self, name: &str, value: &T) -> Self {
        self.add(ParamLocation::Header, name, value)
    }

    pub fn cookie<T: Serialize + ?Sized>(self, name: &str, value: &T) -> Self {
        self.add(ParamLocation::Cookie, name, value)
    }

    /// A JSON body (sent with the operation's media type).
    pub fn json_body<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(bytes) => self.body = Some(PendingBody::Json(bytes)),
            Err(e) => self.fail(format!("The request body cannot be serialized as JSON: {e}")),
        }
        self
    }

    /// An `application/x-www-form-urlencoded` body from the value's JSON properties.
    pub fn form_body<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        match serde_json::to_value(value).ok().as_ref().and_then(FormBody::from_json) {
            Some(form) => self.body = Some(PendingBody::Form(form)),
            None => self.fail("A form body must serialize to a JSON object.".into()),
        }
        self
    }

    pub fn form(mut self, form: FormBody) -> Self {
        self.body = Some(PendingBody::Form(form));
        self
    }

    pub fn multipart(mut self, multipart: MultipartBody) -> Self {
        if let Some(e) = multipart.error() {
            self.fail(e.to_owned());
        }
        self.body = Some(PendingBody::Multipart(multipart));
        self
    }

    pub fn text_body(mut self, value: impl Into<String>) -> Self {
        self.body = Some(PendingBody::Text(value.into()));
        self
    }

    /// A raw body, sent with the operation's media type (the file's content type when the operation has none).
    pub fn binary_body(mut self, file: ApiFile) -> Self {
        self.body = Some(PendingBody::Binary(file));
        self
    }

    /// A body built by hand, with its Content-Type (`None` sends none).
    pub fn body(mut self, body: ApiBody, content_type: Option<String>) -> Self {
        self.body = Some(PendingBody::Raw(body, content_type));
        self
    }

    /// The value of a parameter, or `None` when it was not set (or set to null).
    pub(crate) fn get(&self, location: ParamLocation, name: &str) -> Option<&Value> {
        self.values.iter().find(|(l, n, _)| *l == location && n == name).map(|(_, _, v)| v)
    }

    pub(crate) fn take_body(&mut self) -> Option<PendingBody> {
        self.body.take()
    }

    pub(crate) fn error(&self) -> Option<&InvalidRequestError> {
        self.error.as_ref()
    }

    fn add<T: Serialize + ?Sized>(mut self, location: ParamLocation, name: &str, value: &T) -> Self {
        match serde_json::to_value(value) {
            Ok(Value::Null) => {}
            Ok(v) => {
                self.values.retain(|(l, n, _)| !(*l == location && n == name));
                self.values.push((location, name.to_owned(), v));
            }
            Err(e) => self.fail(format!("Parameter \"{name}\" cannot be serialized: {e}")),
        }
        self
    }

    fn fail(&mut self, message: String) {
        if self.error.is_none() {
            self.error = Some(InvalidRequestError::new(message));
        }
    }
}
