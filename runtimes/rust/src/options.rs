use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::auth::{AuthConfig, CustomAuth};
use crate::headers::ApiHeaders;
use crate::middleware::Middleware;

/// Client configuration (fixed when the client is built; middleware can still be appended with `use_middleware`).
#[derive(Clone, Default)]
pub struct ClientOptions {
    /// Absolute base URL; its path is kept (`https://x.test/api/` + `/foo` → `https://x.test/api/foo`).
    pub base_url: String,
    /// Headers sent with every request.
    pub headers: ApiHeaders,
    /// Time allowed until the final response headers arrive (redirects included; reading the body is not timed).
    pub timeout: Option<Duration>,
    /// Middleware, outermost first.
    pub middleware: Vec<Arc<dyn Middleware>>,
    /// The reqwest client to send with (also used for OAuth2 token requests). Build it with [`http_client_builder`]
    /// (redirects disabled): the runtime follows redirects itself and drops credentials when the origin changes.
    /// When unset, such a client is created on first use.
    pub http_client: Option<reqwest::Client>,
    /// Called last when applying authentication; also satisfies schemes the generator could not model.
    pub custom_auth: Option<Arc<dyn CustomAuth>>,
    /// Credentials per security scheme (the generated `ApiAuth`).
    pub auth: Option<Arc<dyn AuthConfig>>,
}

impl fmt::Debug for ClientOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientOptions")
            .field("base_url", &self.base_url)
            .field("headers", &self.headers)
            .field("timeout", &self.timeout)
            .field("middleware", &self.middleware.len())
            .field("http_client", &self.http_client.is_some())
            .field("custom_auth", &self.custom_auth.is_some())
            .field("auth", &self.auth.is_some())
            .finish()
    }
}

/// Per-call settings.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Extra headers for this call (they override client headers with the same name).
    pub headers: ApiHeaders,
    /// Values handed to middleware through [`crate::CallContext::extension`].
    pub extensions: HashMap<String, Value>,
    /// Overrides the client's base URL for this call.
    pub base_url: Option<String>,
}

impl RequestOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.set(name, value);
        self
    }

    pub fn extension(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.extensions.insert(key.into(), value.into());
        self
    }

    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }
}

/// A reqwest client builder with redirects disabled, for [`ClientOptions::http_client`].
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
}
