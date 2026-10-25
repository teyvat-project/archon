use std::error::Error as StdError;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;

use crate::body::ApiBody;
use crate::errors::{Error, InvalidRequestError, TransportError};
use crate::headers::ApiHeaders;
use crate::middleware::BoxFuture;
use crate::request::ApiRequest;
use crate::response::ApiResponse;
use crate::url;

const MAX_REDIRECTS: u32 = 20;
const BODY_HEADERS: [&str; 5] = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type", "Content-Length"];

/// Names that carry credentials and must not cross origins.
#[derive(Debug, Clone, Default)]
pub(crate) struct CredentialNames {
    pub headers: Vec<String>,
    pub query: Vec<String>,
}

/// Sends requests with reqwest, following redirects by hand so credentials are dropped when the origin changes.
pub(crate) struct Transport {
    pub http: reqwest::Client,
    pub timeout: Option<Duration>,
    pub credentials: CredentialNames,
}

impl Transport {
    /// The timeout covers everything up to the final response's headers (redirects included), not reading the body.
    pub fn send(&self, req: ApiRequest) -> BoxFuture<'_, Result<ApiResponse, Error>> {
        Box::pin(async move {
            let (response, url) = match self.timeout.filter(|t| !t.is_zero()) {
                Some(limit) => match tokio::time::timeout(limit, self.follow(req)).await {
                    Ok(result) => result?,
                    Err(_) => {
                        return Err(Error::Transport(TransportError::timeout(format!(
                            "Request timed out after {}ms.",
                            limit.as_millis()
                        ))))
                    }
                },
                None => self.follow(req).await?,
            };
            let status = response.status().as_u16();
            let headers = response_headers(response.headers());
            let data = response.bytes().await.map_err(|e| Error::Transport(transport_error("Reading the response failed", e)))?;
            Ok(ApiResponse { status, headers, url, data: data.to_vec() })
        })
    }

    async fn follow(&self, req: ApiRequest) -> Result<(reqwest::Response, String), Error> {
        let ApiRequest { mut method, mut url, mut headers, mut body } = req;
        let mut redirects = 0;
        loop {
            let replayable = body.as_ref().is_none_or(ApiBody::replayable);
            let outgoing = match body.as_ref() {
                Some(ApiBody::Bytes(bytes)) => Some(reqwest::Body::from(bytes.clone())),
                Some(ApiBody::Stream(_)) => match body.take() {
                    Some(ApiBody::Stream(stream)) => Some(stream),
                    _ => None,
                },
                None => None,
            };
            let response = self.send_once(&method, &url, &headers, outgoing).await?;

            let status = response.status().as_u16();
            let location =
                response.headers().get(reqwest::header::LOCATION).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
            // 303 (except HEAD) and 301/302 on POST switch to a bodiless GET; everything else re-sends the body.
            let to_get = if status == 303 { method != Method::HEAD } else { status < 303 && method == Method::POST };
            let Some(location) = location.filter(|_| matches!(status, 301 | 302 | 303 | 307 | 308)) else {
                return Ok((response, url));
            };
            if !to_get && !replayable {
                return Ok((response, url));
            }
            if redirects >= MAX_REDIRECTS {
                return Err(Error::Transport(TransportError::new(format!("Too many redirects (more than {MAX_REDIRECTS})."))));
            }
            redirects += 1;

            let mut next = url::resolve(&url, &location)
                .ok_or_else(|| Error::Transport(TransportError::new(format!("Invalid redirect location \"{location}\"."))))?;
            if !url::same_origin(&next, &url) {
                for name in self.credentials.headers.iter().map(String::as_str).chain(["Authorization", "Cookie"]) {
                    headers.remove(name);
                }
                next = url::without_query_parameters(&next, &self.credentials.query);
            }
            if to_get {
                method = Method::GET;
                body = None;
                for name in BODY_HEADERS {
                    headers.remove(name);
                }
            }
            url = next;
        }
    }

    async fn send_once(
        &self,
        method: &Method,
        url: &str,
        headers: &ApiHeaders,
        body: Option<reqwest::Body>,
    ) -> Result<reqwest::Response, Error> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|e| Error::InvalidRequest(InvalidRequestError::new(format!("Invalid request URL \"{url}\": {e}"))))?;
        let mut request = reqwest::Request::new(method.clone(), parsed);
        let mut map = HeaderMap::new();
        for (name, value) in headers.iter() {
            // reqwest derives Content-Length from the body.
            if name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            let header = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::InvalidRequest(InvalidRequestError::new(format!("Invalid header name \"{name}\"."))))?;
            let value = HeaderValue::from_bytes(value.as_bytes())
                .map_err(|_| Error::InvalidRequest(InvalidRequestError::new(format!("Invalid value for header \"{name}\"."))))?;
            map.append(header, value);
        }
        *request.headers_mut() = map;
        *request.body_mut() = body;
        self.http.execute(request).await.map_err(|e| Error::Transport(transport_error("Request failed", e)))
    }
}

/// Headers with multiple values joined by `", "`.
fn response_headers(map: &HeaderMap) -> ApiHeaders {
    let mut headers = ApiHeaders::new();
    for name in map.keys() {
        let values: Vec<String> = map.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        headers.set(name.as_str(), values.join(", "));
    }
    headers
}

/// A transport error whose message includes the causes (reqwest's own message is terse).
pub(crate) fn transport_error(prefix: &str, error: reqwest::Error) -> TransportError {
    let mut message = format!("{prefix}: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    let timed_out = error.is_timeout();
    let mut e = TransportError::new(message).with_source(error);
    e.timed_out = timed_out;
    e
}
