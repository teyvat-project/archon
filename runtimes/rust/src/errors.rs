use std::error::Error as StdError;
use std::fmt;

use crate::headers::ApiHeaders;

type Source = Box<dyn StdError + Send + Sync>;

/// The error of an operation call. `E` is the operation's typed error body (`()` when it declares none, and in
/// middleware, which sees non-2xx responses as responses).
#[derive(Debug)]
pub enum Error<E = ()> {
    /// A non-2xx response (boxed: it holds the whole response, and keeps `Result`s small).
    Api(Box<ApiError<E>>),
    /// The request could not be sent or the response could not be read (network failure, timeout).
    Transport(TransportError),
    /// A successful response whose body could not be decoded.
    Decode(DecodeError),
    /// Required credentials are not configured (raised before sending), or obtaining a token failed.
    Auth(AuthError),
    /// The request could not be built (missing path parameter, invalid header value, relative base URL, ...).
    InvalidRequest(InvalidRequestError),
}

impl<E> Error<E> {
    /// The HTTP status of an [`Error::Api`].
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api(e) => Some(e.status),
            _ => None,
        }
    }

    /// The [`ApiError`], when this is a non-2xx response.
    pub fn api_error(&self) -> Option<&ApiError<E>> {
        match self {
            Error::Api(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}

impl Error<()> {
    /// Converts an error without a typed body (as middleware raises them) into an operation's error type.
    pub fn with_body_type<F>(self) -> Error<F> {
        match self {
            Error::Api(e) => {
                let ApiError { status, headers, url, raw_body, body: _ } = *e;
                Error::Api(Box::new(ApiError { status, headers, url, raw_body, body: None }))
            }
            Error::Transport(e) => Error::Transport(e),
            Error::Decode(e) => Error::Decode(e),
            Error::Auth(e) => Error::Auth(e),
            Error::InvalidRequest(e) => Error::InvalidRequest(e),
        }
    }
}

impl<E> fmt::Display for Error<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Api(e) => write!(f, "HTTP {}", e.status),
            Error::Transport(e) => e.fmt(f),
            Error::Decode(e) => e.fmt(f),
            Error::Auth(e) => e.fmt(f),
            Error::InvalidRequest(e) => e.fmt(f),
        }
    }
}

impl<E: fmt::Debug> StdError for Error<E> {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Error::Api(_) => None,
            Error::Transport(e) => e.source(),
            Error::Decode(e) => e.source(),
            Error::Auth(e) => e.source(),
            Error::InvalidRequest(_) => None,
        }
    }
}

impl<E> From<TransportError> for Error<E> {
    fn from(e: TransportError) -> Self {
        Error::Transport(e)
    }
}

impl<E> From<DecodeError> for Error<E> {
    fn from(e: DecodeError) -> Self {
        Error::Decode(e)
    }
}

impl<E> From<AuthError> for Error<E> {
    fn from(e: AuthError) -> Self {
        Error::Auth(e)
    }
}

impl<E> From<InvalidRequestError> for Error<E> {
    fn from(e: InvalidRequestError) -> Self {
        Error::InvalidRequest(e)
    }
}

/// A non-2xx response.
#[derive(Debug, Clone)]
pub struct ApiError<E> {
    pub status: u16,
    pub headers: ApiHeaders,
    /// The final request URL.
    pub url: String,
    /// The response body as received.
    pub raw_body: Vec<u8>,
    /// The body decoded as the type the operation declares for this status; `None` when it declares none or the
    /// body does not decode.
    pub body: Option<E>,
}

impl<E> ApiError<E> {
    /// The raw body as UTF-8 text (invalid sequences replaced).
    pub fn raw_text(&self) -> String {
        String::from_utf8_lossy(&self.raw_body).into_owned()
    }
}

/// The request could not be sent or the response could not be read.
#[derive(Debug)]
pub struct TransportError {
    pub message: String,
    /// `true` when the client timeout elapsed.
    pub timed_out: bool,
    source: Option<Source>,
}

impl TransportError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), timed_out: false, source: None }
    }

    /// A timeout.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self { message: message.into(), timed_out: true, source: None }
    }

    pub fn with_source(mut self, source: impl Into<Source>) -> Self {
        self.source = Some(source.into());
        self
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for TransportError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_deref().map(|s| s as &(dyn StdError + 'static))
    }
}

/// A successful response whose body could not be decoded.
#[derive(Debug)]
pub struct DecodeError {
    pub status: u16,
    /// The body as text (`""` when it was empty).
    pub raw_body: String,
    pub message: String,
    source: Option<Source>,
}

impl DecodeError {
    pub fn new(status: u16, raw_body: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, raw_body: raw_body.into(), message: message.into(), source: None }
    }

    pub fn with_source(mut self, source: impl Into<Source>) -> Self {
        self.source = Some(source.into());
        self
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for DecodeError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_deref().map(|s| s as &(dyn StdError + 'static))
    }
}

/// Required credentials are not configured, or obtaining credentials failed.
#[derive(Debug)]
pub struct AuthError {
    /// The security schemes involved.
    pub schemes: Vec<String>,
    pub message: String,
    source: Option<Source>,
}

impl AuthError {
    pub fn new(schemes: Vec<String>, message: impl Into<String>) -> Self {
        Self { schemes, message: message.into(), source: None }
    }

    pub fn with_source(mut self, source: impl Into<Source>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// The same error attributed to `scheme` when it names no scheme yet (e.g. a failing token provider).
    pub(crate) fn for_scheme(mut self, scheme: &str) -> Self {
        if self.schemes.is_empty() {
            self.schemes.push(scheme.to_owned());
        }
        self
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for AuthError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_deref().map(|s| s as &(dyn StdError + 'static))
    }
}

/// The request could not be built from the given values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRequestError {
    pub message: String,
}

impl InvalidRequestError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl fmt::Display for InvalidRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for InvalidRequestError {}
