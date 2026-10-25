use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Method;
use serde_json::Value;

use crate::auth::{OAuth2ClientAuth, OAuth2Value, TokenSet};
use crate::base64;
use crate::body::FormBody;
use crate::errors::AuthError;
use crate::transport::transport_error;
use crate::url;

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

fn system_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Obtains and caches OAuth2 access tokens through the client-credentials or refresh-token grant. Tokens are renewed
/// `leeway` (default 30 s) before they expire; concurrent requests for the same scopes share one token request
/// (single-flight). When the caller doing the token request is dropped, the request stops and the next waiting
/// caller makes it again.
pub struct OAuth2TokenManager {
    http: reqwest::Client,
    config: OAuth2Value,
    token_url: Option<String>,
    base_url: Option<String>,
    schemes: Vec<String>,
    clock: Clock,
    leeway_millis: u64,
    timeout: Option<Duration>,
    cache: Mutex<HashMap<String, TokenSet>>,
    flights: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    refresh_token: Mutex<Option<String>>,
}

impl OAuth2TokenManager {
    /// `token_url` is the spec's token URL, used when the grant configures none; relative token URLs resolve
    /// against `base_url`.
    pub fn new(
        http: reqwest::Client,
        config: OAuth2Value,
        token_url: Option<String>,
        base_url: Option<String>,
        scheme: &str,
    ) -> Self {
        let refresh_token = config.refresh_token.as_ref().map(|r| r.refresh_token.clone());
        Self {
            http,
            config,
            token_url,
            base_url,
            schemes: vec![scheme.to_owned()],
            clock: Arc::new(system_millis),
            leeway_millis: 30_000,
            timeout: None,
            cache: Mutex::new(HashMap::new()),
            flights: Mutex::new(HashMap::new()),
            refresh_token: Mutex::new(refresh_token),
        }
    }

    /// Replaces the clock (milliseconds; epoch milliseconds by default).
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// How long before expiry a token is renewed (default 30 s).
    pub fn with_leeway(mut self, leeway: Duration) -> Self {
        self.leeway_millis = leeway.as_millis() as u64;
        self
    }

    /// The time allowed for a token request.
    pub fn with_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.timeout = timeout;
        self
    }

    /// Whether tokens are obtained by a grant (rather than supplied as an access token).
    pub fn managed(&self) -> bool {
        self.config.client_credentials.is_some() || self.config.refresh_token.is_some()
    }

    /// A fresh access token for `scopes` (plus the grant's own scopes).
    pub async fn get_token(&self, scopes: &[&str]) -> Result<String, AuthError> {
        let mut requested: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
        if let Some(credentials) = &self.config.client_credentials {
            requested.extend(credentials.scopes.iter().cloned());
        }
        requested.sort();
        requested.dedup();
        let key = if self.config.refresh_token.is_some() { String::new() } else { requested.join(" ") };

        if let Some(token) = self.fresh(&key) {
            return Ok(token);
        }
        let flight = self.flights.lock().unwrap_or_else(|e| e.into_inner()).entry(key.clone()).or_default().clone();
        let _guard = flight.lock().await;
        // Another caller may have fetched the token while this one waited.
        if let Some(token) = self.fresh(&key) {
            return Ok(token);
        }
        let tokens = self.fetch(&requested).await?;
        let access = tokens.access_token.clone();
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, tokens);
        Ok(access)
    }

    /// Drops cached tokens so the next request fetches a new one. With `rejected` only entries holding that token
    /// are dropped, so a caller holding a stale token cannot discard a newer one.
    pub fn invalidate(&self, rejected: Option<&str>) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, t| rejected.is_some_and(|r| t.access_token != r));
    }

    fn fresh(&self, key: &str) -> Option<String> {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let tokens = cache.get(key)?;
        match tokens.expires_at_millis {
            Some(expires_at) if expires_at.saturating_sub(self.leeway_millis) <= (self.clock)() => None,
            _ => Some(tokens.access_token.clone()),
        }
    }

    fn error(&self, message: impl Into<String>) -> AuthError {
        AuthError::new(self.schemes.clone(), message)
    }

    async fn fetch(&self, scopes: &[String]) -> Result<TokenSet, AuthError> {
        let refresh = self.config.refresh_token.as_ref();
        let credentials = self.config.client_credentials.as_ref();
        let (client_id, client_secret, client_auth, configured_url) = match (refresh, credentials) {
            (Some(r), _) => (&r.client_id, r.client_secret.as_ref(), r.client_auth, r.token_url.as_ref()),
            (None, Some(c)) => (&c.client_id, Some(&c.client_secret), c.client_auth, c.token_url.as_ref()),
            (None, None) => {
                return Err(self.error("The OAuth2 scheme has neither client_credentials nor refresh_token configured."))
            }
        };
        let configured = configured_url
            .or(self.token_url.as_ref())
            .ok_or_else(|| self.error("No token URL is configured for the OAuth2 token request."))?;
        let token_url = self.resolve(configured)?;

        let mut form = FormBody::new();
        if refresh.is_some() {
            let current = self.refresh_token.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
            form = form.add("grant_type", "refresh_token").add("refresh_token", current);
        } else {
            form = form.add("grant_type", "client_credentials");
            if !scopes.is_empty() {
                form = form.add("scope", scopes.join(" "));
            }
        }
        let mut request = self
            .http
            .request(Method::POST, &token_url)
            .header("Accept", "application/json")
            .header("Content-Type", FormBody::CONTENT_TYPE);
        match client_secret {
            Some(secret) if client_auth == OAuth2ClientAuth::Basic => {
                request = request
                    .header("Authorization", format!("Basic {}", base64::encode(format!("{client_id}:{secret}").as_bytes())));
            }
            _ => {
                form = form.add("client_id", client_id.as_str());
                if let Some(secret) = client_secret {
                    form = form.add("client_secret", secret.as_str());
                }
            }
        }
        let exchange = async {
            let response = request.body(form.to_bytes()).send().await?;
            let status = response.status().as_u16();
            Ok::<_, reqwest::Error>((status, response.bytes().await?))
        };
        let result = match self.timeout.filter(|t| !t.is_zero()) {
            Some(limit) => tokio::time::timeout(limit, exchange)
                .await
                .map_err(|_| self.error(format!("The token request timed out after {}ms.", limit.as_millis())))?,
            None => exchange.await,
        };
        let (status, body) = result.map_err(|e| {
            let cause = transport_error("The token request failed", e);
            self.error(cause.message.clone()).with_source(cause)
        })?;
        if !(200..300).contains(&status) {
            return Err(self.error(format!("The token endpoint responded with HTTP {status}.")));
        }

        let data: Value = serde_json::from_slice(&body)
            .map_err(|e| self.error("The token endpoint returned a response that is not valid JSON.").with_source(e))?;
        let string = |name: &str| data.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let access_token =
            string("access_token").ok_or_else(|| self.error("The token endpoint response has no access_token."))?;
        let expires_in = match data.get("expires_in") {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => s.parse::<f64>().ok(),
            _ => None,
        }
        .filter(|s| s.is_finite());
        let tokens = TokenSet {
            access_token,
            refresh_token: string("refresh_token"),
            expires_at_millis: expires_in.map(|s| ((self.clock)() as f64 + s * 1000.0).max(0.0) as u64),
            scope: data.get("scope").and_then(Value::as_str).map(str::to_owned),
        };
        if let (Some(rotated), Some(refresh)) = (&tokens.refresh_token, refresh) {
            *self.refresh_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(rotated.clone());
            if let Some(callback) = &refresh.on_refreshed {
                callback(&tokens);
            }
        }
        Ok(tokens)
    }

    /// An absolute URL is used as-is; a relative one resolves against the base URL.
    fn resolve(&self, token_url: &str) -> Result<String, AuthError> {
        if url::is_absolute_http(token_url) {
            return Ok(token_url.to_owned());
        }
        self.base_url.as_deref().filter(|b| url::is_absolute_http(b)).and_then(|base| url::resolve(base, token_url)).ok_or_else(
            || self.error(format!("Cannot resolve the relative token URL \"{token_url}\" without an absolute base URL.")),
        )
    }
}

impl fmt::Debug for OAuth2TokenManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuth2TokenManager").field("schemes", &self.schemes).field("token_url", &self.token_url).finish()
    }
}
