mod support;

use std::sync::Arc;

use archon_runtime::{
    decode_json, ApiKeyLocation, BodyKind, ClientOptions, Method, OperationSpec, RequestOptions, RequestValues, ResponseKind,
    SecuritySchemeSpec,
};
use support::{core_with, get, op, Reply, TestServer};

static SCHEMES: [(&str, SecuritySchemeSpec); 2] = [
    ("header", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Header, name: "X-API-Key" }),
    ("query", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Query, name: "api_key" }),
];
static START: OperationSpec = get("/start");
static POST: OperationSpec =
    op(Method::POST, "/start", &[], Some((BodyKind::Text, "text/plain")), &[("200", ResponseKind::Text)]);

fn redirecting(status: u16, location: String) -> TestServer {
    TestServer::start(move |req| match req.path() {
        "/start" => Reply::status(status).header("Location", &location),
        _ => Reply::json(200, "{}"),
    })
}

fn options(base_url: &str) -> ClientOptions {
    let headers =
        [("Authorization", "Bearer t"), ("X-API-Key", "k"), ("Cookie", "session=s"), ("X-Other", "o")].into_iter().collect();
    ClientOptions { base_url: base_url.to_owned(), headers, ..ClientOptions::default() }
}

#[tokio::test]
async fn manual_redirect_strips_credentials_on_cross_origin_hop() {
    let other = TestServer::replying(Reply::json(200, "{}"));
    let server = redirecting(302, format!("{}/landing?api_key=k&keep=1", other.url));
    let core = core_with(options(&server.url), &SCHEMES);
    let response =
        core.send::<serde_json::Value, ()>(&START, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    assert_eq!(response.url, format!("{}/landing?keep=1", other.url));
    let landed = other.last();
    assert_eq!(landed.target, "/landing?keep=1");
    for name in ["authorization", "x-api-key", "cookie"] {
        assert_eq!(landed.header(name), None, "{name}");
    }
    assert_eq!(landed.header("x-other"), Some("o"));
}

#[tokio::test]
async fn same_origin_redirect_keeps_headers() {
    let server = redirecting(307, "/landing".into());
    let core = core_with(options(&server.url), &SCHEMES);
    core.send::<serde_json::Value, ()>(&START, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    let landed = server.last();
    assert_eq!(landed.path(), "/landing");
    assert_eq!(landed.header("authorization"), Some("Bearer t"));
    assert_eq!(landed.header("x-api-key"), Some("k"));
}

#[tokio::test]
async fn see_other_converts_post_to_get_and_307_keeps_the_body() {
    let server = redirecting(303, "/landing".into());
    let core = core_with(options(&server.url), &[]);
    core.send::<String, ()>(&POST, RequestValues::new().text_body("hi"), archon_runtime::decode_text, RequestOptions::new())
        .await
        .unwrap();
    let landed = server.last();
    assert_eq!((landed.method.as_str(), landed.header("content-type"), landed.body.len()), ("GET", None, 0));

    let server = redirecting(307, "/landing".into());
    let core = core_with(options(&server.url), &[]);
    core.send::<String, ()>(&POST, RequestValues::new().text_body("hi"), archon_runtime::decode_text, RequestOptions::new())
        .await
        .unwrap();
    let landed = server.last();
    assert_eq!((landed.method.as_str(), landed.text().as_str()), ("POST", "hi"));
}

#[tokio::test]
async fn non_replayable_body_returns_the_redirect() {
    let server = redirecting(307, "/landing".into());
    let core = core_with(options(&server.url), &[]);
    let body = archon_runtime::ApiBody::Stream(reqwest::Body::from("hi"));
    let error = core
        .send::<String, ()>(
            &POST,
            RequestValues::new().body(body, Some("text/plain".into())),
            archon_runtime::decode_text,
            RequestOptions::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(307));
    assert_eq!(server.count(), 1);
}

#[tokio::test]
async fn user_client_is_used() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    let http = archon_runtime::http_client_builder().user_agent("custom-agent").build().unwrap();
    let options = ClientOptions { base_url: server.url.clone(), http_client: Some(http), ..ClientOptions::default() };
    let core = Arc::new(core_with(options, &[]));
    core.send::<serde_json::Value, ()>(&START, RequestValues::new(), decode_json, RequestOptions::new()).await.unwrap();
    assert_eq!(server.last().header("user-agent"), Some("custom-agent"));
}
