mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use archon_runtime::{
    decode_empty, decode_error_json, decode_json, middleware_fn, ApiClientCore, ClientOptions, Error, ErrorBody, Method,
    OperationSpec, ParamLocation, ParamSpec, ParamStyle, RequestOptions, RequestValues, ResponseKind,
};
use serde::Deserialize;
use support::{closed_url, core, core_with, get, op, Reply, TestServer};

static PING: OperationSpec = get("/ping");
static EMPTY: OperationSpec = op(Method::GET, "/empty", &[], None, &[("204", ResponseKind::Empty)]);
static FOO: OperationSpec = op(
    Method::GET,
    "/foo/{id}",
    &[
        ParamSpec { name: "id", location: ParamLocation::Path, style: ParamStyle::Simple, explode: false, allow_reserved: false },
        ParamSpec {
            name: "piped",
            location: ParamLocation::Query,
            style: ParamStyle::PipeDelimited,
            explode: false,
            allow_reserved: false,
        },
        ParamSpec {
            name: "filter",
            location: ParamLocation::Query,
            style: ParamStyle::DeepObject,
            explode: true,
            allow_reserved: false,
        },
    ],
    None,
    &[("200", ResponseKind::Json)],
);

#[derive(Debug, Deserialize, PartialEq)]
struct Pong {
    ok: bool,
}

#[derive(Debug, Deserialize, PartialEq)]
struct NotFound {
    resource: String,
}

#[derive(Debug, PartialEq)]
enum PingError {
    Status404(NotFound),
}

impl ErrorBody for PingError {
    fn decode(status: u16, body: &[u8]) -> Option<Self> {
        match status {
            404 => decode_error_json(body).map(PingError::Status404),
            _ => None,
        }
    }
}

#[tokio::test]
async fn builds_url_preserving_base_url_path() {
    let server = TestServer::replying(Reply::json(200, r#"{"ok":true}"#));
    let core = core(&format!("{}/api/", server.url));
    let values = RequestValues::new().path("id", &1);
    let _: Result<_, Error> = core.send(&FOO, values, decode_json::<Pong>, RequestOptions::new()).await;
    assert_eq!(server.last().target, "/api/foo/1");
}

#[tokio::test]
async fn sends_pipe_brackets_and_escapes_unchanged() {
    let server = TestServer::replying(Reply::json(200, r#"{"ok":true}"#));
    let core = core(&format!("{}?x=%41", server.url));
    let values = RequestValues::new().path("id", "a/b").query("piped", &[1, 2]).query("filter", &serde_json::json!({ "a": "b" }));
    let _: Result<_, Error> = core.send(&FOO, values, decode_json::<Pong>, RequestOptions::new()).await;
    assert_eq!(server.last().target, "/foo/a%2Fb?x=%41&piped=1|2&filter[a]=b");
}

#[tokio::test]
async fn returns_typed_data_on_2xx() {
    let server = TestServer::replying(Reply::json(200, r#"{"ok":true,"extra":1}"#).header("X-Id", "7"));
    let response =
        core(&server.url).send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.data, Pong { ok: true });
    assert_eq!(response.headers.get("x-id"), Some("7"));
    assert_eq!(response.url, format!("{}/ping", server.url));
}

#[tokio::test]
async fn api_error_with_typed_body_on_404() {
    let server = TestServer::replying(Reply::json(404, r#"{"resource":"x"}"#));
    let error = core(&server.url)
        .send::<Pong, PingError>(&PING, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .unwrap_err();
    let Error::Api(api) = error else { panic!("{error:?}") };
    assert_eq!(api.status, 404);
    assert_eq!(api.body, Some(PingError::Status404(NotFound { resource: "x".into() })));
    assert_eq!(api.raw_text(), r#"{"resource":"x"}"#);
}

#[tokio::test]
async fn api_error_without_body_when_error_is_not_json() {
    let server = TestServer::replying(Reply::text(404, "nope"));
    let error = core(&server.url)
        .send::<Pong, PingError>(&PING, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(404));
    let api = error.api_error().unwrap();
    assert_eq!(api.body, None);
    assert_eq!(api.raw_text(), "nope");
    assert_eq!(error.to_string(), "HTTP 404");
}

#[tokio::test]
async fn returns_none_for_204_when_type_is_option_and_decode_error_otherwise() {
    let server = TestServer::replying(Reply::status(204));
    let core = core(&server.url);
    let none = core.send::<Option<Pong>, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    assert_eq!(none.data, None);
    let error = core.send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap_err();
    let Error::Decode(decode) = error else { panic!("{error:?}") };
    assert_eq!((decode.status, decode.raw_body.as_str()), (204, ""));
    let empty = core.send::<(), ()>(&EMPTY, RequestValues::new(), decode_empty, RequestOptions::new()).await.unwrap();
    assert_eq!(empty.status, 204);
    assert_eq!(server.last().header("accept"), Some("*/*"));
}

#[tokio::test]
async fn decode_error_on_invalid_json() {
    let server = TestServer::replying(Reply::json(200, "{nope"));
    let error =
        core(&server.url).send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap_err();
    let Error::Decode(decode) = error else { panic!("{error:?}") };
    assert_eq!(decode.raw_body, "{nope");
}

#[tokio::test]
async fn transport_error_on_connection_refused() {
    let error =
        core(&closed_url()).send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap_err();
    let Error::Transport(transport) = error else { panic!("{error:?}") };
    assert!(!transport.timed_out);
}

#[tokio::test]
async fn timeout_is_transport_error_with_timed_out() {
    let server = TestServer::replying(Reply::json(200, "{}").delay(Duration::from_millis(500)));
    let options =
        ClientOptions { base_url: server.url.clone(), timeout: Some(Duration::from_millis(100)), ..ClientOptions::default() };
    let error = core_with(options, &[])
        .send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .unwrap_err();
    let Error::Transport(transport) = error else { panic!("{error:?}") };
    assert!(transport.timed_out, "{transport:?}");
}

fn recorder(log: &Arc<Mutex<Vec<String>>>, name: &'static str) -> Arc<dyn archon_runtime::Middleware> {
    let log = log.clone();
    Arc::new(middleware_fn(move |req, _ctx, next| {
        let log = log.clone();
        Box::pin(async move {
            log.lock().unwrap().push(format!("{name}:before"));
            let response = next.run(req).await;
            log.lock().unwrap().push(format!("{name}:after"));
            response
        })
    }))
}

#[tokio::test]
async fn runs_middleware_outer_to_inner_with_auth_innermost() {
    let server = TestServer::replying(Reply::json(200, r#"{"ok":true}"#));
    let log = Arc::new(Mutex::new(Vec::new()));
    let auth_log = log.clone();
    let options = ClientOptions {
        base_url: server.url.clone(),
        middleware: vec![recorder(&log, "mw1")],
        custom_auth: Some(Arc::new(move |_req: &mut archon_runtime::ApiRequest, _ctx: &archon_runtime::CallContext| {
            auth_log.lock().unwrap().push("auth".into());
            Ok(())
        })),
        ..ClientOptions::default()
    };
    let core = ApiClientCore::new(options, &[]);
    core.use_middleware(recorder(&log, "mw2"));
    core.send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    assert_eq!(*log.lock().unwrap(), ["mw1:before", "mw2:before", "auth", "mw2:after", "mw1:after"]);
}

#[tokio::test]
async fn context_carries_operation_and_extensions() {
    let server = TestServer::replying(Reply::json(200, r#"{"ok":true}"#));
    let seen = Arc::new(Mutex::new(None));
    let sink = seen.clone();
    let core = core(&server.url);
    core.use_middleware(Arc::new(middleware_fn(move |req, ctx, next| {
        *sink.lock().unwrap() = Some((ctx.operation_name, ctx.method.clone(), ctx.attempt(), ctx.extension("trace")));
        next.run(req)
    })));
    let options = RequestOptions::new().extension("trace", "t-1").header("X-Extra", "1");
    core.send::<Pong, ()>(&PING, RequestValues::new(), decode_json, options).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(("test", Method::GET, 1, Some(serde_json::json!("t-1")))));
    assert_eq!(server.last().header("x-extra"), Some("1"));
}

#[tokio::test]
async fn invalid_requests_are_reported_before_sending() {
    let error =
        core("/relative").send::<Pong, ()>(&PING, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap_err();
    assert!(matches!(error, Error::InvalidRequest(_)), "{error:?}");

    let server = TestServer::replying(Reply::json(200, "{}"));
    let error =
        core(&server.url).send::<Pong, ()>(&FOO, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap_err();
    assert!(matches!(error, Error::InvalidRequest(_)), "{error:?}");
    let options = RequestOptions::new().header("X-Bad", "a\nb");
    let error = core(&server.url).send::<Pong, ()>(&PING, RequestValues::new(), decode_json, options).await.unwrap_err();
    assert!(matches!(error, Error::InvalidRequest(_)), "{error:?}");
    assert_eq!(server.count(), 0);
}
