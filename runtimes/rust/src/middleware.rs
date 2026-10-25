use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use reqwest::Method;
use serde_json::Value;

use crate::errors::Error;
use crate::request::ApiRequest;
use crate::response::ApiResponse;
use crate::specs::{OperationSpec, SecurityRequirement};
use crate::transport::Transport;

/// A boxed, sendable future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One layer of the onion chain. Middleware runs outer-to-inner in registration order; authentication is applied
/// innermost, so calling `next` again re-applies fresh credentials. Non-2xx responses come back as `Ok`.
///
/// Implement it on a type, or wrap a closure with [`middleware_fn`].
pub trait Middleware: Send + Sync {
    fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>>;
}

struct FnMiddleware<F>(F);

impl<F> Middleware for FnMiddleware<F>
where
    F: for<'a> Fn(ApiRequest, &'a CallContext, Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> + Send + Sync,
{
    fn handle<'a>(&'a self, req: ApiRequest, ctx: &'a CallContext, next: Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        (self.0)(req, ctx, next)
    }
}

/// A middleware from a closure: `middleware_fn(|req, ctx, next| Box::pin(async move { next.run(req).await }))`.
pub fn middleware_fn<F>(f: F) -> impl Middleware
where
    F: for<'a> Fn(ApiRequest, &'a CallContext, Next<'a>) -> BoxFuture<'a, Result<ApiResponse, Error>> + Send + Sync + 'static,
{
    FnMiddleware(f)
}

/// The rest of the chain. It is `Copy`: call [`Next::run`] again to re-send (with a fresh request).
#[derive(Clone, Copy)]
pub struct Next<'a> {
    middleware: &'a [Arc<dyn Middleware>],
    context: &'a CallContext,
    transport: &'a Transport,
}

impl<'a> Next<'a> {
    pub(crate) fn new(middleware: &'a [Arc<dyn Middleware>], context: &'a CallContext, transport: &'a Transport) -> Self {
        Self { middleware, context, transport }
    }

    /// Runs the inner middleware and the transport.
    pub fn run(self, req: ApiRequest) -> BoxFuture<'a, Result<ApiResponse, Error>> {
        match self.middleware.split_first() {
            Some((first, rest)) => first.handle(req, self.context, Next { middleware: rest, ..self }),
            None => self.transport.send(req),
        }
    }
}

/// What the middleware chain knows about the call in flight.
#[derive(Debug)]
pub struct CallContext {
    pub operation_name: &'static str,
    pub method: Method,
    pub path_template: &'static str,
    pub tags: &'static [&'static str],
    pub security: &'static [SecurityRequirement],
    /// Header names (case-insensitive) carrying credentials, to mask in logs.
    pub redact_headers: Vec<String>,
    /// Query parameter names (case-insensitive) carrying credentials, to mask in logs.
    pub redact_query: Vec<String>,
    attempt: AtomicU32,
    extensions: Mutex<HashMap<String, Value>>,
}

impl CallContext {
    /// A context for `operation` (attempt 1, no extensions).
    pub fn new(operation: &'static OperationSpec) -> Self {
        Self {
            operation_name: operation.operation_name,
            method: operation.method.clone(),
            path_template: operation.path,
            tags: operation.tags,
            security: operation.security,
            redact_headers: Vec::new(),
            redact_query: Vec::new(),
            attempt: AtomicU32::new(1),
            extensions: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn with_extensions(mut self, extensions: HashMap<String, Value>) -> Self {
        self.extensions = Mutex::new(extensions);
        self
    }

    /// 1 for the first send; retrying middleware increments it.
    pub fn attempt(&self) -> u32 {
        self.attempt.load(Ordering::SeqCst)
    }

    /// Increments the attempt counter; returns the new value.
    pub fn increment_attempt(&self) -> u32 {
        self.attempt.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// A per-call value (from [`crate::RequestOptions::extension`] or set by middleware).
    pub fn extension(&self, key: &str) -> Option<Value> {
        self.extensions.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
    }

    pub fn set_extension(&self, key: impl Into<String>, value: impl Into<Value>) {
        self.extensions.lock().unwrap_or_else(|e| e.into_inner()).insert(key.into(), value.into());
    }
}
