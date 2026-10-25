use crate::headers::ApiHeaders;

/// A response. In the middleware chain `data` is the raw body (read completely); operations return it decoded.
#[derive(Debug, Clone)]
pub struct ApiResponse<T = Vec<u8>> {
    pub status: u16,
    pub headers: ApiHeaders,
    /// The URL that produced this response (after redirects).
    pub url: String,
    pub data: T,
}

impl<T> ApiResponse<T> {
    pub fn into_data(self) -> T {
        self.data
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> ApiResponse<U> {
        ApiResponse { status: self.status, headers: self.headers, url: self.url, data: f(self.data) }
    }
}
