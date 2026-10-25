use std::collections::hash_map::RandomState;
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Method;

use crate::errors::Error;
use crate::middleware::{BoxFuture, CallContext, Middleware, Next};
use crate::request::ApiRequest;
use crate::response::ApiResponse;
use crate::url;

const MASK: &str = "***";
const DEFAULT_REDACT_HEADERS: [&str; 4] = ["authorization", "cookie", "proxy-authorization", "set-cookie"];

type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// Logs `→ METHOD url` (optionally with headers) and `← status (ms)`. Credentials are masked as `***`:
/// `Authorization`, `Cookie`, `Proxy-Authorization`, `Set-Cookie`, the API key headers and query parameters of the
/// spec, and the names added with [`LoggingMiddleware::redact_header`] / [`LoggingMiddleware::redact_query`]
/// (case-insensitive).
#[derive(Clone)]
pub struct LoggingMiddleware {
    log: Log,
    include_headers: bool,
    redact_headers: Vec<String>,
    redact_query: Vec<String>,
}

impl Default for LoggingMiddleware {
    /// Logs to standard error.
    fn default() -> Self {
        Self::new(|line| eprintln!("{line}"))
    }
}

impl LoggingMiddleware {
    /// Sends each log line to `log`.
    pub fn new(log: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self { log: Arc::new(log), include_headers: false, redact_headers: Vec::new(), redact_query: Vec::new() }
    }

    /// Also log request headers, one line each.
    pub fn include_headers(mut self, include: bool) -> Self {
        self.include_headers = include;
        self
    }

    pub fn redact_header(mut self, name: impl Into<String>) -> Self {
        self.redact_headers.push(name.into());
        self
    }

    pub fn redact_query(mut self, name: impl Into<String>) -> Self {
        self.redact_query.push(name.into());
        self
    }
}

impl fmt::Debug for LoggingMiddleware {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoggingMiddleware").field("include_headers", &self.include_headers).finish()
    }
}

fn contains_ignore_case<'a>(names: impl IntoIterator<Item = &'a str>, name: &str) -> bool {
    names.into_iter().any(|n| n.eq_ignore_ascii_case(name))
}

/// The URL for display, without its fragment and with the values of the given query names masked.
fn masked_url(raw: &str, redact: &[&str]) -> String {
    let mut parts = url::split(raw);
    parts.fragment = None;
    if let Some(query) = parts.query.take() {
        let pairs: Vec<String> = url::query_pairs(Some(&query))
            .into_iter()
            .map(|pair| match pair.find('=') {
                Some(eq) if contains_ignore_case(redact.iter().copied(), &url::decode_name(pair)) => {
                    format!("{}={MASK}", &pair[..eq])
                }
                _ => pair.to_owned(),
            })
            .collect();
        parts.query = Some(pairs.join("&"));
    }
    parts.render()
}

impl Middleware for LoggingMiddleware {
    fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        Box::pin(async move {
            let headers: Vec<&str> = DEFAULT_REDACT_HEADERS
                .iter()
                .copied()
                .chain(ctx.redact_headers.iter().map(String::as_str))
                .chain(self.redact_headers.iter().map(String::as_str))
                .collect();
            let query: Vec<&str> = ctx.redact_query.iter().chain(&self.redact_query).map(String::as_str).collect();

            (self.log)(&format!("→ {} {}", req.method, masked_url(&req.url, &query)));
            if self.include_headers {
                for (name, value) in req.headers.iter() {
                    let shown = if contains_ignore_case(headers.iter().copied(), name) { MASK } else { value };
                    (self.log)(&format!("  {name}: {shown}"));
                }
            }
            let started = Instant::now();
            let response = next.run(req).await?;
            (self.log)(&format!("← {} ({}ms)", response.status, started.elapsed().as_millis()));
            Ok(response)
        })
    }
}

/// Sets the `User-Agent` header.
#[derive(Debug, Clone)]
pub struct UserAgentMiddleware {
    value: String,
}

impl UserAgentMiddleware {
    pub fn new(value: impl Into<String>) -> Self {
        Self { value: value.into() }
    }
}

impl Middleware for UserAgentMiddleware {
    fn handle<'a>(
        &'a self,
        mut req: ApiRequest,
        _ctx: &'a CallContext,
        next: Next<'a>,
    ) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        req.headers.set("User-Agent", self.value.clone());
        next.run(req)
    }
}

type Sleep = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;
type Random = Arc<dyn Fn() -> f64 + Send + Sync>;
type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// A random number in [0, 1) without a dependency: `RandomState` hashes are randomly keyed.
fn random_unit() -> f64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

fn system_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Retries idempotent, replayable requests on the configured statuses and on network errors (not on timeouts),
/// with exponential backoff and equal jitter. `Retry-After` on 429 / 503 is honoured, capped by `max_retry_after`.
#[derive(Clone)]
pub struct RetryMiddleware {
    max_attempts: u32,
    base_delay: Duration,
    max_delay: Duration,
    max_retry_after: Duration,
    statuses: Vec<u16>,
    methods: Vec<Method>,
    retry_on_network_error: bool,
    sleep: Sleep,
    random: Random,
    clock: Clock,
}

impl Default for RetryMiddleware {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
            max_retry_after: Duration::from_secs(60),
            statuses: vec![408, 429, 500, 502, 503, 504],
            methods: vec![Method::GET, Method::HEAD, Method::OPTIONS, Method::PUT, Method::DELETE],
            retry_on_network_error: true,
            sleep: Arc::new(|d| Box::pin(tokio::time::sleep(d))),
            random: Arc::new(random_unit),
            clock: Arc::new(system_millis),
        }
    }
}

impl RetryMiddleware {
    pub fn new() -> Self {
        Self::default()
    }

    /// Total sends, the first included (default 3).
    pub fn max_attempts(mut self, max_attempts: u32) -> Self {
        self.max_attempts = max_attempts;
        self
    }

    pub fn base_delay(mut self, delay: Duration) -> Self {
        self.base_delay = delay;
        self
    }

    pub fn max_delay(mut self, delay: Duration) -> Self {
        self.max_delay = delay;
        self
    }

    /// Upper bound for a server-supplied `Retry-After` (default 60 s).
    pub fn max_retry_after(mut self, delay: Duration) -> Self {
        self.max_retry_after = delay;
        self
    }

    /// Statuses retried (default 408, 429, 500, 502, 503, 504).
    pub fn statuses(mut self, statuses: impl IntoIterator<Item = u16>) -> Self {
        self.statuses = statuses.into_iter().collect();
        self
    }

    /// Methods retried (idempotent ones by default).
    pub fn methods(mut self, methods: impl IntoIterator<Item = Method>) -> Self {
        self.methods = methods.into_iter().collect();
        self
    }

    pub fn retry_on_network_error(mut self, retry: bool) -> Self {
        self.retry_on_network_error = retry;
        self
    }

    /// Replaces the wait between attempts (default `tokio::time::sleep`).
    pub fn with_sleep<F, Fut>(mut self, sleep: F) -> Self
    where
        F: Fn(Duration) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.sleep = Arc::new(move |d| Box::pin(sleep(d)));
        self
    }

    /// Replaces the random source in [0, 1) for the jitter.
    pub fn with_random(mut self, random: impl Fn() -> f64 + Send + Sync + 'static) -> Self {
        self.random = Arc::new(random);
        self
    }

    /// Replaces the clock (epoch milliseconds) used for `Retry-After` dates.
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// Equal jitter: `min(max_delay, base_delay * 2^(attempt-1)) * (0.5 + random / 2)`.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let exponential =
            (self.base_delay.as_millis() as f64 * 2f64.powi(attempt as i32 - 1)).min(self.max_delay.as_millis() as f64);
        Duration::from_millis((exponential * (0.5 + (self.random)() / 2.0)) as u64)
    }

    /// Seconds or an HTTP-date (RFC 1123); `None` when absent or unparseable.
    fn retry_after(&self, value: Option<&str>) -> Option<Duration> {
        let value = value?.trim();
        if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
            return value.parse::<u64>().ok().map(Duration::from_secs);
        }
        let date = parse_http_date(value)?;
        Some(Duration::from_millis(date.saturating_sub((self.clock)())))
    }
}

impl fmt::Debug for RetryMiddleware {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RetryMiddleware")
            .field("max_attempts", &self.max_attempts)
            .field("base_delay", &self.base_delay)
            .field("max_delay", &self.max_delay)
            .field("max_retry_after", &self.max_retry_after)
            .field("statuses", &self.statuses)
            .field("methods", &self.methods)
            .field("retry_on_network_error", &self.retry_on_network_error)
            .finish()
    }
}

impl Middleware for RetryMiddleware {
    fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        Box::pin(async move {
            let retryable = req.replayable() && self.methods.contains(&req.method);
            let mut attempt = 1;
            let mut current = req;
            loop {
                let spare = if retryable && attempt < self.max_attempts { current.try_clone() } else { None };
                let delay = match next.run(current).await {
                    Err(Error::Transport(e)) if spare.is_some() && self.retry_on_network_error && !e.timed_out => {
                        self.backoff(attempt)
                    }
                    Err(e) => return Err(e),
                    Ok(response) => {
                        if spare.is_none() || !self.statuses.contains(&response.status) {
                            return Ok(response);
                        }
                        let retry_after = match response.status {
                            429 | 503 => self.retry_after(response.headers.get("Retry-After")),
                            _ => None,
                        };
                        retry_after.map_or_else(|| self.backoff(attempt), |d| d.min(self.max_retry_after))
                    }
                };
                (self.sleep)(delay).await;
                attempt += 1;
                ctx.increment_attempt();
                current = spare.expect("checked above");
            }
        })
    }
}

type OnUnauthorized = Arc<dyn for<'a> Fn(&'a CallContext, &'a ApiResponse) -> BoxFuture<'a, bool> + Send + Sync>;

/// Re-sends once after a 401 when the callback returns `true` (e.g. after rotating a static token). Managed OAuth2
/// tokens already refresh once on 401 inside the authentication layer, so the callback should return `false` for
/// those schemes.
#[derive(Clone)]
pub struct Retry401Middleware {
    on_unauthorized: OnUnauthorized,
}

impl Retry401Middleware {
    /// `Retry401Middleware::new(|ctx, response| Box::pin(async move { rotate_token().await; true }))`.
    pub fn new<F>(on_unauthorized: F) -> Self
    where
        F: for<'a> Fn(&'a CallContext, &'a ApiResponse) -> BoxFuture<'a, bool> + Send + Sync + 'static,
    {
        Self { on_unauthorized: Arc::new(on_unauthorized) }
    }
}

impl fmt::Debug for Retry401Middleware {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Retry401Middleware")
    }
}

impl Middleware for Retry401Middleware {
    fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        Box::pin(async move {
            let spare = req.try_clone();
            let response = next.run(req).await?;
            let Some(again) = spare.filter(|_| response.status == 401) else { return Ok(response) };
            if !(self.on_unauthorized)(ctx, &response).await {
                return Ok(response);
            }
            ctx.increment_attempt();
            next.run(again).await
        })
    }
}

/// An RFC 1123 date (`Sun, 06 Nov 1994 08:49:37 GMT`) as epoch milliseconds.
fn parse_http_date(value: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let rest = value.split_once(", ")?.1;
    let fields: Vec<&str> = rest.split(' ').collect();
    let [day, month, year, time, "GMT"] = fields.as_slice() else { return None };
    let number =
        |s: &str, len: usize| (s.len() == len && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<i64>().ok()).flatten();
    let day = number(day, 2)?;
    let month = MONTHS.iter().position(|m| m.eq_ignore_ascii_case(month))? as i64 + 1;
    let year = number(year, 4)?;
    let clock: Vec<&str> = time.split(':').collect();
    let [h, m, s] = clock.as_slice() else { return None };
    let (h, m, s) = (number(h, 2)?, number(m, 2)?, number(s, 2)?);
    if !(1..=31).contains(&day) || h > 23 || m > 59 || s > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    u64::try_from((((days * 24 + h) * 60 + m) * 60 + s) * 1000).ok()
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
