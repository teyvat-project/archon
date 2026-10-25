use std::sync::{Arc, OnceLock, RwLock};

use crate::auth::AuthMiddleware;
use crate::decode::ErrorBody;
use crate::errors::{ApiError, DecodeError, Error, InvalidRequestError, TransportError};
use crate::middleware::{CallContext, Middleware, Next};
use crate::options::{http_client_builder, ClientOptions, RequestOptions};
use crate::params::{serialize_cookie, serialize_header, serialize_path, serialize_query};
use crate::request::ApiRequest;
use crate::response::ApiResponse;
use crate::specs::{ApiKeyLocation, OperationSpec, ParamLocation, ResponseKind, SecuritySchemeSpec};
use crate::transport::{CredentialNames, Transport};
use crate::url;
use crate::values::RequestValues;

/// What the core and the authentication layer share.
pub(crate) struct Shared {
    pub options: ClientOptions,
    pub schemes: &'static [(&'static str, SecuritySchemeSpec)],
    default_http: OnceLock<Result<reqwest::Client, String>>,
}

impl Shared {
    /// [`ClientOptions::http_client`], or a client of our own (redirects disabled) created on first use.
    pub fn http_client(&self) -> Result<reqwest::Client, TransportError> {
        if let Some(client) = &self.options.http_client {
            return Ok(client.clone());
        }
        match self.default_http.get_or_init(|| http_client_builder().build().map_err(|e| e.to_string())) {
            Ok(client) => Ok(client.clone()),
            Err(message) => Err(TransportError::new(format!("The HTTP client could not be created: {message}"))),
        }
    }

    pub fn scheme(&self, name: &str) -> Option<SecuritySchemeSpec> {
        self.schemes.iter().find(|(n, _)| *n == name).map(|(_, spec)| *spec)
    }
}

/// Builds, sends and decodes operation calls for a generated client.
pub struct ApiClientCore {
    shared: Arc<Shared>,
    middleware: RwLock<Vec<Arc<dyn Middleware>>>,
    auth: Arc<dyn Middleware>,
    credentials: CredentialNames,
    redact_headers: Vec<String>,
    redact_query: Vec<String>,
}

impl ApiClientCore {
    pub fn new(options: ClientOptions, security_schemes: &'static [(&'static str, SecuritySchemeSpec)]) -> Self {
        let mut headers = Vec::new();
        let mut query = Vec::new();
        let mut cookie = false;
        for (_, spec) in security_schemes {
            if let SecuritySchemeSpec::ApiKey { location, name } = spec {
                match location {
                    ApiKeyLocation::Header => headers.push((*name).to_owned()),
                    ApiKeyLocation::Query => query.push((*name).to_owned()),
                    ApiKeyLocation::Cookie => cookie = true,
                }
            }
        }
        let mut credential_headers = headers.clone();
        if cookie {
            credential_headers.push("Cookie".to_owned());
        }
        let middleware = RwLock::new(options.middleware.clone());
        let shared = Arc::new(Shared { options, schemes: security_schemes, default_http: OnceLock::new() });
        Self {
            auth: Arc::new(AuthMiddleware::new(shared.clone())),
            shared,
            middleware,
            credentials: CredentialNames { headers: credential_headers, query: query.clone() },
            redact_headers: headers,
            redact_query: query,
        }
    }

    pub fn options(&self) -> &ClientOptions {
        &self.shared.options
    }

    pub fn security_schemes(&self) -> &'static [(&'static str, SecuritySchemeSpec)] {
        self.shared.schemes
    }

    /// Appends a middleware (inside those already registered, outside authentication).
    pub fn use_middleware(&self, middleware: Arc<dyn Middleware>) {
        self.middleware.write().unwrap_or_else(|e| e.into_inner()).push(middleware);
    }

    /// The reqwest client requests go through.
    pub fn http_client(&self) -> Result<reqwest::Client, TransportError> {
        self.shared.http_client()
    }

    /// Sends one operation call. Non-2xx responses become [`Error::Api`] with the body decoded by `E`.
    pub async fn send<T, E: ErrorBody>(
        &self,
        operation: &'static OperationSpec,
        mut values: RequestValues,
        decode: fn(u16, &[u8]) -> Result<T, DecodeError>,
        options: RequestOptions,
    ) -> Result<ApiResponse<T>, Error<E>> {
        let request = self.build_request(operation, &mut values, &options)?;
        let mut context = CallContext::new(operation).with_extensions(options.extensions);
        context.redact_headers = self.redact_headers.clone();
        context.redact_query = self.redact_query.clone();
        let transport = Transport {
            http: self.shared.http_client()?,
            timeout: self.shared.options.timeout,
            credentials: self.credentials.clone(),
        };
        let chain: Vec<Arc<dyn Middleware>> = {
            let middleware = self.middleware.read().unwrap_or_else(|e| e.into_inner());
            middleware.iter().cloned().chain([self.auth.clone()]).collect()
        };

        let response = Next::new(&chain, &context, &transport).run(request).await.map_err(Error::with_body_type)?;
        if !response.is_success() {
            let body = E::decode(response.status, &response.data);
            return Err(Error::Api(ApiError {
                status: response.status,
                headers: response.headers,
                url: response.url,
                raw_body: response.data,
                body,
            }));
        }
        let data = decode(response.status, &response.data)?;
        Ok(ApiResponse { status: response.status, headers: response.headers, url: response.url, data })
    }

    fn build_request(
        &self,
        operation: &OperationSpec,
        values: &mut RequestValues,
        options: &RequestOptions,
    ) -> Result<ApiRequest, InvalidRequestError> {
        if let Some(error) = values.error() {
            return Err(error.clone());
        }
        let path = serialize_path(operation.path, operation.params, values)?;
        let base_url = options.base_url.as_deref().unwrap_or(&self.shared.options.base_url);
        let (base_path, base_query) = base_url.split_once('?').unwrap_or((base_url, ""));
        let query = serialize_query(operation.params, values);
        let full_query = [base_query, query.as_str()].into_iter().filter(|q| !q.is_empty()).collect::<Vec<_>>().join("&");
        let mut url = format!("{}/{}", base_path.trim_end_matches('/'), path.trim_start_matches('/'));
        if !full_query.is_empty() {
            url.push('?');
            url.push_str(&full_query);
        }
        if !url::is_absolute_http(&url) {
            return Err(InvalidRequestError::new(format!(
                "\"{url}\" is not an absolute http(s) URL; pass an absolute base URL (e.g. \"https://api.example.com\")."
            )));
        }

        let mut headers = self.shared.options.headers.clone();
        for spec in operation.params.iter().filter(|s| s.location == ParamLocation::Header) {
            if let Some(value) = values.get(ParamLocation::Header, spec.name) {
                if let Some(text) = serialize_header(spec, value)? {
                    headers.set(spec.name, text);
                }
            }
        }
        for (name, value) in options.headers.iter() {
            headers.set(name, value);
        }
        if let Some(cookie) = serialize_cookie(operation.params, values) {
            let merged = match headers.get("Cookie") {
                Some(existing) => format!("{existing}; {cookie}"),
                None => cookie,
            };
            headers.set("Cookie", merged);
        }

        let mut body = None;
        if operation.body.is_some() {
            if let Some(pending) = values.take_body() {
                let (resolved, content_type) = pending.resolve(operation.body_media_type);
                match content_type {
                    None => {
                        headers.remove("Content-Type");
                    }
                    Some(content_type) if !options.headers.contains("Content-Type") => headers.set("Content-Type", content_type),
                    Some(_) => {}
                }
                body = Some(resolved);
            }
        }
        if !headers.contains("Accept") {
            let json = operation.responses.iter().any(|(_, kind)| *kind == ResponseKind::Json);
            headers.set("Accept", if json { "application/json" } else { "*/*" });
        }
        Ok(ApiRequest { method: operation.method.clone(), url, headers, body })
    }
}
