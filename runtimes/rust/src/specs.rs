use reqwest::Method;

/// Where a parameter is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParamLocation {
    Path,
    Query,
    Header,
    Cookie,
}

/// OpenAPI parameter serialization style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParamStyle {
    Simple,
    Label,
    Matrix,
    Form,
    SpaceDelimited,
    PipeDelimited,
    DeepObject,
}

/// How one operation parameter is serialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamSpec {
    pub name: &'static str,
    pub location: ParamLocation,
    pub style: ParamStyle,
    pub explode: bool,
    pub allow_reserved: bool,
}

/// Encoding of a request body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Json,
    Form,
    Multipart,
    Text,
    Binary,
}

/// Decoding of a response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    Json,
    Text,
    Binary,
    Empty,
}

/// Where an API key is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyLocation {
    Header,
    Query,
    Cookie,
}

/// A security scheme the runtime knows how to apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecuritySchemeSpec {
    /// `Authorization: Bearer <token>`.
    HttpBearer,
    /// `Authorization: Basic <base64(user:pass)>`.
    HttpBasic,
    /// An API key in a header, the query string or a cookie.
    ApiKey { location: ApiKeyLocation, name: &'static str },
    /// OAuth2; the URLs are the spec defaults (relative ones resolve against the base URL).
    OAuth2 { token_url: Option<&'static str>, refresh_url: Option<&'static str> },
    /// OpenID Connect, treated like OAuth2 without discovery.
    OpenIdConnect,
}

/// One scheme of a security requirement, with the scopes it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecurityScheme {
    pub name: &'static str,
    pub scopes: &'static [&'static str],
}

/// An AND of schemes. An empty list means the operation also accepts no authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecurityRequirement {
    pub schemes: &'static [SecurityScheme],
}

/// Everything the runtime needs to know about one operation (generated as a `const`).
#[derive(Debug, Clone)]
pub struct OperationSpec {
    pub operation_name: &'static str,
    pub method: Method,
    pub path: &'static str,
    pub tags: &'static [&'static str],
    /// OR of AND requirements; empty when the operation needs no authentication.
    pub security: &'static [SecurityRequirement],
    pub params: &'static [ParamSpec],
    pub body: Option<BodyKind>,
    pub body_media_type: Option<&'static str>,
    /// Response kind per status key: `"200"`, `"2XX"` or `"default"`.
    pub responses: &'static [(&'static str, ResponseKind)],
}
