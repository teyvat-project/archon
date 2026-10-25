use reqwest::Method;

use crate::body::ApiBody;
use crate::headers::ApiHeaders;
use crate::url;

/// One HTTP request travelling through the middleware chain.
#[derive(Debug)]
pub struct ApiRequest {
    pub method: Method,
    /// The absolute URL. The runtime builds it byte for byte; reqwest normalizes it (WHATWG URL) when sending.
    pub url: String,
    pub headers: ApiHeaders,
    pub body: Option<ApiBody>,
}

impl ApiRequest {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self { method, url: url.into(), headers: ApiHeaders::new(), body: None }
    }

    /// Whether the request can be sent again (buffered bodies can; streams cannot).
    pub fn replayable(&self) -> bool {
        self.body.as_ref().is_none_or(ApiBody::replayable)
    }

    /// A copy for another send (retries, re-authentication); `None` when the body is a stream.
    pub fn try_clone(&self) -> Option<ApiRequest> {
        let body = match &self.body {
            Some(body) => Some(body.try_clone()?),
            None => None,
        };
        Some(ApiRequest { method: self.method.clone(), url: self.url.clone(), headers: self.headers.clone(), body })
    }

    /// Sets a query parameter, replacing any with the same name and leaving the other parameters' bytes untouched.
    pub fn set_query_parameter(&mut self, name: &str, value: &str) {
        self.url = url::set_query_parameter(&self.url, name, value);
    }
}
