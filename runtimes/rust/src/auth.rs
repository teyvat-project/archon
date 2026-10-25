use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};

use crate::base64;
use crate::client::Shared;
use crate::encoding;
use crate::errors::{AuthError, Error};
use crate::middleware::{BoxFuture, CallContext, Middleware, Next};
use crate::oauth2::OAuth2TokenManager;
use crate::request::ApiRequest;
use crate::response::ApiResponse;
use crate::specs::{ApiKeyLocation, SecurityRequirement, SecuritySchemeSpec};

type Provider<T> = Arc<dyn Fn() -> BoxFuture<'static, Result<T, AuthError>> + Send + Sync>;

fn fixed<T: Clone + Send + Sync + 'static>(value: T) -> Provider<T> {
    Arc::new(move || {
        let value = value.clone();
        Box::pin(async move { Ok(value) })
    })
}

fn infallible<T, F, Fut>(f: F) -> Provider<T>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    Arc::new(move || {
        let future = f();
        Box::pin(async move { Ok(future.await) })
    })
}

fn fallible<T, F, Fut, E>(f: F) -> Provider<T>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<T, E>> + Send + 'static,
    E: Into<Box<dyn StdError + Send + Sync>>,
{
    Arc::new(move || {
        let future = f();
        Box::pin(async move {
            future.await.map_err(|e| {
                let source = e.into();
                AuthError::new(Vec::new(), format!("The credential provider failed: {source}")).with_source(source)
            })
        })
    })
}

/// A bearer token or API key: a fixed string or a provider called on every send.
#[derive(Clone)]
pub struct TokenValue {
    provider: Provider<String>,
}

impl TokenValue {
    pub fn new(token: impl Into<String>) -> Self {
        Self { provider: fixed(token.into()) }
    }

    /// A provider called on every send: `TokenValue::provider(|| async { load_token() })`.
    pub fn provider<F, Fut>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = String> + Send + 'static,
    {
        Self { provider: infallible(f) }
    }

    /// A provider that can fail; its error becomes an [`AuthError`].
    pub fn try_provider<F, Fut, E>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<String, E>> + Send + 'static,
        E: Into<Box<dyn StdError + Send + Sync>>,
    {
        Self { provider: fallible(f) }
    }

    pub async fn get(&self) -> Result<String, AuthError> {
        (self.provider)().await
    }
}

impl From<&str> for TokenValue {
    fn from(token: &str) -> Self {
        Self::new(token)
    }
}

impl From<String> for TokenValue {
    fn from(token: String) -> Self {
        Self::new(token)
    }
}

impl fmt::Debug for TokenValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TokenValue(***)")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BasicCredentials {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for BasicCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BasicCredentials").field("username", &self.username).field("password", &"***").finish()
    }
}

/// HTTP Basic credentials: fixed or from a provider called on every send.
#[derive(Clone)]
pub struct BasicValue {
    provider: Provider<BasicCredentials>,
}

impl BasicValue {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self { provider: fixed(BasicCredentials { username: username.into(), password: password.into() }) }
    }

    pub fn provider<F, Fut>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = BasicCredentials> + Send + 'static,
    {
        Self { provider: infallible(f) }
    }

    pub fn try_provider<F, Fut, E>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<BasicCredentials, E>> + Send + 'static,
        E: Into<Box<dyn StdError + Send + Sync>>,
    {
        Self { provider: fallible(f) }
    }

    pub async fn get(&self) -> Result<BasicCredentials, AuthError> {
        (self.provider)().await
    }
}

impl fmt::Debug for BasicValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BasicValue(***)")
    }
}

/// How the client authenticates at the token endpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OAuth2ClientAuth {
    /// `Authorization: Basic` (client_secret_basic).
    #[default]
    Basic,
    /// `client_id` / `client_secret` in the form (client_secret_post).
    Post,
}

/// The client-credentials grant.
#[derive(Clone)]
pub struct OAuth2ClientCredentials {
    pub client_id: String,
    pub client_secret: String,
    /// Scopes requested in addition to those the operation needs.
    pub scopes: Vec<String>,
    /// Overrides the spec's token URL (relative URLs resolve against the base URL).
    pub token_url: Option<String>,
    pub client_auth: OAuth2ClientAuth,
}

impl OAuth2ClientCredentials {
    pub fn new(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            scopes: Vec::new(),
            token_url: None,
            client_auth: OAuth2ClientAuth::Basic,
        }
    }
}

impl fmt::Debug for OAuth2ClientCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuth2ClientCredentials")
            .field("client_id", &self.client_id)
            .field("client_secret", &"***")
            .field("scopes", &self.scopes)
            .field("token_url", &self.token_url)
            .field("client_auth", &self.client_auth)
            .finish()
    }
}

/// Called with every token response that carries a (rotated) refresh token.
pub type OnRefreshed = Arc<dyn Fn(&TokenSet) + Send + Sync>;

/// The refresh-token grant.
#[derive(Clone)]
pub struct OAuth2RefreshToken {
    pub refresh_token: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_url: Option<String>,
    pub client_auth: OAuth2ClientAuth,
    /// Called after every token response that carries a (rotated) refresh token.
    pub on_refreshed: Option<OnRefreshed>,
}

impl OAuth2RefreshToken {
    pub fn new(refresh_token: impl Into<String>, client_id: impl Into<String>) -> Self {
        Self {
            refresh_token: refresh_token.into(),
            client_id: client_id.into(),
            client_secret: None,
            token_url: None,
            client_auth: OAuth2ClientAuth::Basic,
            on_refreshed: None,
        }
    }
}

impl fmt::Debug for OAuth2RefreshToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuth2RefreshToken")
            .field("refresh_token", &"***")
            .field("client_id", &self.client_id)
            .field("client_secret", &self.client_secret.as_ref().map(|_| "***"))
            .field("token_url", &self.token_url)
            .field("client_auth", &self.client_auth)
            .field("on_refreshed", &self.on_refreshed.is_some())
            .finish()
    }
}

/// OAuth2 / OpenID Connect credentials: a ready access token, or a grant the runtime runs and caches.
#[derive(Debug, Clone, Default)]
pub struct OAuth2Value {
    pub access_token: Option<TokenValue>,
    pub client_credentials: Option<OAuth2ClientCredentials>,
    pub refresh_token: Option<OAuth2RefreshToken>,
}

impl OAuth2Value {
    pub fn access_token(token: impl Into<TokenValue>) -> Self {
        Self { access_token: Some(token.into()), ..Self::default() }
    }

    pub fn client_credentials(grant: OAuth2ClientCredentials) -> Self {
        Self { client_credentials: Some(grant), ..Self::default() }
    }

    pub fn refresh_token(grant: OAuth2RefreshToken) -> Self {
        Self { refresh_token: Some(grant), ..Self::default() }
    }

    pub(crate) fn is_configured(&self) -> bool {
        self.access_token.is_some() || self.client_credentials.is_some() || self.refresh_token.is_some()
    }
}

/// A token response; `expires_at_millis` is in the manager's clock (epoch milliseconds by default).
#[derive(Clone, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_millis: Option<u64>,
    pub scope: Option<String>,
}

impl fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenSet")
            .field("access_token", &"***")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "***"))
            .field("expires_at_millis", &self.expires_at_millis)
            .field("scope", &self.scope)
            .finish()
    }
}

/// A configured credential, as [`AuthConfig::get`] returns it.
#[derive(Debug, Clone, Copy)]
pub enum AuthValue<'a> {
    Token(&'a TokenValue),
    Basic(&'a BasicValue),
    OAuth2(&'a OAuth2Value),
}

/// Credentials keyed by security scheme name (implemented by the generated `ApiAuth`).
pub trait AuthConfig: Send + Sync {
    /// The configured value for `scheme`, or `None`.
    fn get(&self, scheme: &str) -> Option<AuthValue<'_>>;
}

/// Authentication the generator cannot model (or extra headers). Implemented for closures
/// `Fn(&mut ApiRequest, &CallContext) -> Result<(), Error>`.
pub trait CustomAuth: Send + Sync {
    fn apply<'a>(&'a self, req: &'a mut ApiRequest, ctx: &'a CallContext) -> BoxFuture<'a, Result<(), Error>>;
}

impl<F> CustomAuth for F
where
    F: Fn(&mut ApiRequest, &CallContext) -> Result<(), Error> + Send + Sync,
{
    fn apply<'a>(&'a self, req: &'a mut ApiRequest, ctx: &'a CallContext) -> BoxFuture<'a, Result<(), Error>> {
        let result = self(req, ctx);
        Box::pin(async move { result })
    }
}

/// Which alternative of an operation's security requirements to apply.
enum Selection {
    Apply(&'static SecurityRequirement),
    Anonymous,
    Missing(Vec<String>),
}

/// Evaluates the OR-of-AND requirements in order and picks the first alternative whose schemes are all configured.
/// An empty alternative (optional auth) is used only when no other one is satisfiable.
fn select(requirements: &'static [SecurityRequirement], is_configured: impl Fn(&str) -> bool) -> Selection {
    let mut optional = false;
    let mut first: Option<&'static SecurityRequirement> = None;
    for requirement in requirements {
        if requirement.schemes.is_empty() {
            optional = true;
            continue;
        }
        first.get_or_insert(requirement);
        if requirement.schemes.iter().all(|s| is_configured(s.name)) {
            return Selection::Apply(requirement);
        }
    }
    match first {
        Some(requirement) if !optional => Selection::Missing(
            requirement.schemes.iter().map(|s| s.name).filter(|n| !is_configured(n)).map(str::to_owned).collect(),
        ),
        _ => Selection::Anonymous,
    }
}

type Used = Vec<(Arc<OAuth2TokenManager>, String)>;

/// Applies authentication innermost in the chain (spec §8.2) and refreshes managed OAuth2 tokens once on 401.
pub(crate) struct AuthMiddleware {
    shared: Arc<Shared>,
    managers: Mutex<HashMap<String, Arc<OAuth2TokenManager>>>,
}

impl AuthMiddleware {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self { shared, managers: Mutex::new(HashMap::new()) }
    }

    fn value(&self, scheme: &str) -> Option<AuthValue<'_>> {
        self.shared.options.auth.as_ref().and_then(|auth| auth.get(scheme))
    }

    fn is_configured(&self, scheme: &str) -> bool {
        // Schemes the generator cannot apply (http digest, mutualTLS, ...) are left out of the scheme table;
        // custom_auth is responsible for them.
        let Some(spec) = self.shared.scheme(scheme) else { return self.shared.options.custom_auth.is_some() };
        match (spec, self.value(scheme)) {
            (SecuritySchemeSpec::OAuth2 { .. } | SecuritySchemeSpec::OpenIdConnect, Some(AuthValue::OAuth2(value))) => {
                value.is_configured()
            }
            (SecuritySchemeSpec::HttpBearer | SecuritySchemeSpec::ApiKey { .. }, Some(AuthValue::Token(_))) => true,
            (SecuritySchemeSpec::HttpBasic, Some(AuthValue::Basic(_))) => true,
            _ => false,
        }
    }

    /// Applies the requirement; returns each token manager used with the token it supplied.
    async fn apply(
        &self,
        requirement: Option<&'static SecurityRequirement>,
        req: &mut ApiRequest,
        ctx: &CallContext,
    ) -> Result<Used, Error> {
        let mut used = Vec::new();
        for scheme in requirement.map_or(&[][..], |r| r.schemes) {
            let Some(spec) = self.shared.scheme(scheme.name) else { continue }; // left to custom_auth
            let for_scheme = |e: AuthError| Error::Auth(e.for_scheme(scheme.name));
            match (spec, self.value(scheme.name)) {
                (SecuritySchemeSpec::HttpBearer, Some(AuthValue::Token(token))) => {
                    let token = token.get().await.map_err(for_scheme)?;
                    req.headers.set("Authorization", format!("Bearer {token}"));
                }
                (SecuritySchemeSpec::HttpBasic, Some(AuthValue::Basic(basic))) => {
                    let c = basic.get().await.map_err(for_scheme)?;
                    let encoded = base64::encode(format!("{}:{}", c.username, c.password).as_bytes());
                    req.headers.set("Authorization", format!("Basic {encoded}"));
                }
                (SecuritySchemeSpec::ApiKey { location, name }, Some(AuthValue::Token(token))) => {
                    let key = token.get().await.map_err(for_scheme)?;
                    match location {
                        ApiKeyLocation::Header => req.headers.set(name, key),
                        ApiKeyLocation::Query => req.set_query_parameter(name, &key),
                        ApiKeyLocation::Cookie => set_cookie(req, name, &encoding::component(&key)),
                    }
                }
                (SecuritySchemeSpec::OAuth2 { .. } | SecuritySchemeSpec::OpenIdConnect, Some(AuthValue::OAuth2(value))) => {
                    let token = match &value.access_token {
                        Some(token) => token.get().await.map_err(for_scheme)?,
                        None => {
                            let manager = self.manager_for(scheme.name, spec, value)?;
                            let token = manager.get_token(scheme.scopes).await?;
                            used.push((manager, token.clone()));
                            token
                        }
                    };
                    req.headers.set("Authorization", format!("Bearer {token}"));
                }
                _ => {}
            }
        }
        if let Some(custom) = &self.shared.options.custom_auth {
            custom.apply(req, ctx).await?;
        }
        Ok(used)
    }

    fn manager_for(&self, scheme: &str, spec: SecuritySchemeSpec, value: &OAuth2Value) -> Result<Arc<OAuth2TokenManager>, Error> {
        let mut managers = self.managers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(manager) = managers.get(scheme) {
            return Ok(manager.clone());
        }
        let spec_url = match spec {
            SecuritySchemeSpec::OAuth2 { token_url, refresh_url } if value.refresh_token.is_some() => refresh_url.or(token_url),
            SecuritySchemeSpec::OAuth2 { token_url, .. } => token_url,
            _ => None,
        };
        let options = &self.shared.options;
        let manager = OAuth2TokenManager::new(
            self.shared.http_client()?,
            value.clone(),
            spec_url.map(str::to_owned),
            Some(options.base_url.clone()),
            scheme,
        )
        .with_timeout(options.timeout);
        let manager = Arc::new(manager);
        managers.insert(scheme.to_owned(), manager.clone());
        Ok(manager)
    }
}

impl Middleware for AuthMiddleware {
    fn handle<'a>(
        &'a self,
        mut req: ApiRequest,
        ctx: &'a CallContext,
        next: Next<'a>,
    ) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        Box::pin(async move {
            let requirement = match select(ctx.security, |s| self.is_configured(s)) {
                Selection::Missing(schemes) => {
                    let message = format!("Missing credentials for security scheme(s): {}.", schemes.join(", "));
                    return Err(Error::Auth(AuthError::new(schemes, message)));
                }
                Selection::Anonymous => None,
                Selection::Apply(requirement) => Some(requirement),
            };

            let used = self.apply(requirement, &mut req, ctx).await?;
            let retry = if used.is_empty() { None } else { req.try_clone() };
            let response = next.run(req).await?;
            let Some(mut again) = retry.filter(|_| response.status == 401) else { return Ok(response) };

            for (manager, token) in &used {
                manager.invalidate(Some(token));
            }
            self.apply(requirement, &mut again, ctx).await?;
            next.run(again).await
        })
    }
}

/// Adds or replaces one cookie in the `Cookie` header.
fn set_cookie(req: &mut ApiRequest, name: &str, value: &str) {
    let mut kept: Vec<String> = req
        .headers
        .get("Cookie")
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .filter(|c| !c.is_empty() && c.split('=').next() != Some(name))
        .map(str::to_owned)
        .collect();
    kept.push(format!("{name}={value}"));
    req.headers.set("Cookie", kept.join("; "));
}
