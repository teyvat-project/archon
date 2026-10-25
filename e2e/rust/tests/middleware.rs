mod support;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use archon_edge_cases::core::{middleware_fn, Error, LoggingMiddleware, Middleware, Retry401Middleware, RetryMiddleware, TokenValue, UserAgentMiddleware};
use archon_edge_cases::services::middleware::FlakyError;
use archon_edge_cases::ApiAuth;
use support::{base_url, builder, strings};

/// A key no other run has used (the server counts attempts per key).
fn key(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{prefix}-{nanos}-{}", NEXT.fetch_add(1, Ordering::SeqCst))
}

#[tokio::test]
async fn retries_503_responses_until_the_endpoint_succeeds() {
    let client = builder().middleware(RetryMiddleware::new()).build();
    let key = key("retry");
    let data = client.middleware().flaky(key.clone()).fail(2).await.unwrap().data;
    assert_eq!((data.key, data.attempts), (key, 3));
}

#[tokio::test]
async fn gives_up_after_max_attempts_and_returns_the_typed_503() {
    let client = builder().middleware(RetryMiddleware::new().max_attempts(2)).build();
    let error = client.middleware().flaky(key("give-up")).fail(5).await.unwrap_err();
    let Error::Api(api) = error else { panic!("{error:?}") };
    assert_eq!(api.status, 503);
    let Some(FlakyError::Status503(body)) = &api.body else { panic!("{api:?}") };
    assert_eq!(body.code, 503);
}

#[tokio::test]
async fn re_sends_once_after_a_401_when_the_token_was_swapped_by_retry401() {
    let token = Arc::new(Mutex::new("expired-token".to_owned()));
    let swaps = Arc::new(Mutex::new(Vec::new()));
    let (current, swapped, log) = (token.clone(), token.clone(), swaps.clone());
    let client = builder()
        .auth(ApiAuth {
            bearer_auth: Some(TokenValue::provider(move || {
                let value = current.lock().unwrap().clone();
                async move { value }
            })),
            ..ApiAuth::default()
        })
        .middleware(Retry401Middleware::new(move |ctx, _response| {
            log.lock().unwrap().push(ctx.attempt());
            *swapped.lock().unwrap() = "test-token".to_owned();
            Box::pin(async { true })
        }))
        .build();
    assert_eq!(client.auth().auth_bearer().await.unwrap().data.headers["authorization"], "Bearer test-token");
    assert_eq!(*swaps.lock().unwrap(), [1]);
}

#[tokio::test]
async fn masks_credentials_in_logs() {
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    // Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
    let with_query_key = middleware_fn(|mut req, _ctx, next| {
        req.set_query_parameter("api_key", "test-key");
        next.run(req)
    });
    let client = builder()
        .header("Authorization", "Bearer test-token")
        .header("X-API-Key", "test-key")
        .middleware(with_query_key)
        .middleware(LoggingMiddleware::new(move |line| sink.lock().unwrap().push(line.to_owned())).include_headers(true))
        .build();
    let echo = client.echo().echo_headers_cookies(strings(&["r1"]), "dark").await.unwrap().data;
    // The server did receive the credentials...
    assert_eq!(echo.headers["authorization"], "Bearer test-token");
    assert_eq!(echo.headers["x-api-key"], "test-key");
    assert_eq!(echo.query, "api_key=test-key");

    // ...but the log did not.
    let lines = lines.lock().unwrap();
    let logged = lines.join("\n");
    for secret in ["test-token", "test-key", "dark"] {
        assert!(!logged.contains(secret), "{secret} in {logged}");
    }
    assert_eq!(lines[0], format!("→ GET {}/echo/headers?api_key=***", base_url()));
    let headers: Vec<String> = lines[1..lines.len() - 1].iter().map(|l| l.trim().to_lowercase()).collect();
    for expected in ["authorization: ***", "x-api-key: ***", "cookie: ***", "x-request-ids: r1"] {
        assert!(headers.iter().any(|h| h == expected), "{expected} in {headers:?}");
    }
    let last = lines.last().unwrap();
    assert!(last.starts_with("← 200 (") && last.ends_with("ms)"), "{last}");
}

#[tokio::test]
async fn sets_the_user_agent() {
    let client = builder().middleware(UserAgentMiddleware::new("archon-e2e/1.0")).build();
    assert_eq!(client.echo().echo_headers_cookies(strings(&["r1"]), "dark").await.unwrap().data.headers["user-agent"], "archon-e2e/1.0");
}

fn tag(name: &'static str, order: &Arc<Mutex<Vec<String>>>) -> impl Middleware {
    let order = order.clone();
    middleware_fn(move |mut req, _ctx, next| {
        let order = order.clone();
        Box::pin(async move {
            order.lock().unwrap().push(format!(">{name}"));
            let trace = req.headers.get("X-Trace").map(|t| format!("{t},{name}")).unwrap_or_else(|| name.to_owned());
            req.headers.set("X-Trace", trace);
            let response = next.run(req).await;
            order.lock().unwrap().push(format!("<{name}"));
            response
        })
    })
}

#[tokio::test]
async fn runs_middleware_in_registration_order_builder_first_then_use() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let client = builder().middleware(tag("a", &order)).middleware(tag("b", &order)).build();
    client.use_middleware(tag("c", &order));
    let echo = client.echo().echo_headers_cookies(strings(&["r1"]), "dark").await.unwrap().data;
    assert_eq!(echo.headers["x-trace"], "a,b,c");
    assert_eq!(*order.lock().unwrap(), [">a", ">b", ">c", "<c", "<b", "<a"]);
}
