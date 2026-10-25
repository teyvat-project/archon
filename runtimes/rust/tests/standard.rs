mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use archon_runtime::{
    decode_json, ApiKeyLocation, BodyKind, ClientOptions, Error, LoggingMiddleware, Method, Middleware, OperationSpec,
    RequestOptions, RequestValues, ResponseKind, RetryMiddleware, SecuritySchemeSpec, UserAgentMiddleware,
};
use support::{closed_url, core_with, get, op, Reply, TestServer};

static GET: OperationSpec = get("/x");
static POST: OperationSpec = op(Method::POST, "/x", &[], Some((BodyKind::Text, "text/plain")), &[("200", ResponseKind::Json)]);
static SCHEMES: [(&str, SecuritySchemeSpec); 2] = [
    ("header", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Header, name: "X-API-Key" }),
    ("query", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Query, name: "api_key" }),
];

type Delays = Arc<Mutex<Vec<Duration>>>;

/// A retry middleware that records its waits instead of sleeping.
fn retry() -> (RetryMiddleware, Delays) {
    let delays: Delays = Arc::new(Mutex::new(Vec::new()));
    let sink = delays.clone();
    let middleware = RetryMiddleware::new().with_random(|| 0.0).with_sleep(move |d| {
        sink.lock().unwrap().push(d);
        async {}
    });
    (middleware, delays)
}

/// Fails `failures` times with `status` (and `headers`), then answers 200.
fn flaky(failures: usize, reply: Reply) -> TestServer {
    let count = AtomicUsize::new(0);
    TestServer::start(
        move |_| if count.fetch_add(1, Ordering::SeqCst) < failures { reply.clone() } else { Reply::json(200, "{}") },
    )
}

async fn send(
    server_url: &str,
    middleware: impl Middleware + 'static,
    op: &'static OperationSpec,
    values: RequestValues,
) -> Result<u16, Error> {
    let options =
        ClientOptions { base_url: server_url.to_owned(), middleware: vec![Arc::new(middleware)], ..ClientOptions::default() };
    core_with(options, &SCHEMES)
        .send::<serde_json::Value, ()>(op, values, decode_json, RequestOptions::new())
        .await
        .map(|r| r.status)
}

#[tokio::test]
async fn retries_503_with_retry_after_seconds() {
    let server = flaky(1, Reply::json(503, "{}").header("Retry-After", "1"));
    let (middleware, delays) = retry();
    assert_eq!(send(&server.url, middleware, &GET, RequestValues::new()).await.unwrap(), 200);
    assert_eq!(*delays.lock().unwrap(), [Duration::from_secs(1)]);
    assert_eq!(server.count(), 2);
}

#[tokio::test]
async fn retries_429_with_retry_after_http_date() {
    let server = flaky(1, Reply::json(429, "{}").header("Retry-After", "Sun, 06 Nov 1994 08:49:42 GMT"));
    let (middleware, delays) = retry();
    let middleware = middleware.with_clock(|| 784_111_777_000); // Sun, 06 Nov 1994 08:49:37 GMT
    assert_eq!(send(&server.url, middleware, &GET, RequestValues::new()).await.unwrap(), 200);
    assert_eq!(*delays.lock().unwrap(), [Duration::from_secs(5)]);
}

#[tokio::test]
async fn caps_retry_after() {
    let server = flaky(1, Reply::json(503, "{}").header("Retry-After", "3600"));
    let (middleware, delays) = retry();
    assert_eq!(
        send(&server.url, middleware.max_retry_after(Duration::from_secs(2)), &GET, RequestValues::new()).await.unwrap(),
        200
    );
    assert_eq!(*delays.lock().unwrap(), [Duration::from_secs(2)]);
}

#[tokio::test]
async fn does_not_retry_post_by_default_nor_non_replayable() {
    let server = flaky(1, Reply::json(503, "{}"));
    let (middleware, _) = retry();
    assert_eq!(send(&server.url, middleware, &POST, RequestValues::new().text_body("x")).await.unwrap_err().status(), Some(503));

    let server = flaky(1, Reply::json(503, "{}"));
    let (middleware, _) = retry();
    let body = archon_runtime::ApiBody::Stream(reqwest::Body::from("x"));
    let middleware = middleware.methods([Method::POST]);
    let result = send(&server.url, middleware, &POST, RequestValues::new().body(body, None)).await;
    assert_eq!(result.unwrap_err().status(), Some(503));
    assert_eq!(server.count(), 1);
}

#[tokio::test]
async fn stops_after_max_attempts_with_exponential_backoff() {
    let server = flaky(10, Reply::json(500, "{}"));
    let (middleware, delays) = retry();
    let error = send(&server.url, middleware.max_attempts(4), &GET, RequestValues::new()).await.unwrap_err();
    assert_eq!(error.status(), Some(500));
    assert_eq!(server.count(), 4);
    assert_eq!(*delays.lock().unwrap(), [100, 200, 400].map(Duration::from_millis));
}

#[tokio::test]
async fn retries_network_errors_but_not_timeouts() {
    let (middleware, delays) = retry();
    let error = send(&closed_url(), middleware, &GET, RequestValues::new()).await.unwrap_err();
    assert!(matches!(error, Error::Transport(_)));
    assert_eq!(delays.lock().unwrap().len(), 2);

    let server = TestServer::replying(Reply::json(200, "{}").delay(Duration::from_millis(300)));
    let (middleware, delays) = retry();
    let options = ClientOptions {
        base_url: server.url.clone(),
        timeout: Some(Duration::from_millis(50)),
        middleware: vec![Arc::new(middleware)],
        ..ClientOptions::default()
    };
    let error = core_with(options, &[])
        .send::<serde_json::Value, ()>(&GET, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .unwrap_err();
    assert!(matches!(&error, Error::Transport(e) if e.timed_out), "{error:?}");
    assert!(delays.lock().unwrap().is_empty());
}

#[test]
fn equal_jitter_bounds() {
    for (random, attempt, expected) in [(0.0, 1, 100), (0.999, 1, 199), (0.0, 3, 400), (0.0, 10, 2500)] {
        let middleware = RetryMiddleware::new().with_random(move || random);
        assert_eq!(middleware.backoff(attempt), Duration::from_millis(expected), "{random} {attempt}");
    }
}

#[tokio::test]
async fn logging_masks_authorization_cookie_and_api_key_query() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let logging = LoggingMiddleware::new(move |line| sink.lock().unwrap().push(line.to_owned()))
        .include_headers(true)
        .redact_header("X-Secret");
    let headers =
        [("Authorization", "Bearer secret-token"), ("Cookie", "a=b"), ("X-API-Key", "key"), ("X-Secret", "s"), ("X-Plain", "p")]
            .into_iter()
            .collect();
    let options = ClientOptions {
        base_url: format!("{}?api_key=key&other=1#frag", server.url),
        headers,
        middleware: vec![Arc::new(logging)],
        ..ClientOptions::default()
    };
    core_with(options, &SCHEMES)
        .send::<serde_json::Value, ()>(&GET, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .unwrap();
    let lines = lines.lock().unwrap();
    let text = lines.join("\n");
    assert!(!text.contains("secret-token") && !text.contains("key&") && !text.contains("a=b"), "{text}");
    assert_eq!(lines[0], format!("→ GET {}/x?api_key=***&other=1", server.url));
    for expected in ["  Authorization: ***", "  Cookie: ***", "  X-API-Key: ***", "  X-Secret: ***", "  X-Plain: p"] {
        assert!(lines.iter().any(|l| l == expected), "{expected} in {lines:?}");
    }
    let last = lines.last().unwrap();
    assert!(last.starts_with("← 200 (") && last.ends_with("ms)"), "{last}");
}

#[tokio::test]
async fn user_agent_sets_header() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    send(&server.url, UserAgentMiddleware::new("archon-test/1.0"), &GET, RequestValues::new()).await.unwrap();
    assert_eq!(server.last().header("user-agent"), Some("archon-test/1.0"));
}
