mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use archon_runtime::{
    decode_json, ApiKeyLocation, ApiRequest, AuthConfig, AuthValue, BasicValue, CallContext, ClientOptions, Error, Method,
    OAuth2ClientCredentials, OAuth2Value, OperationSpec, RequestOptions, RequestValues, ResponseKind, SecurityRequirement,
    SecurityScheme, SecuritySchemeSpec, TokenValue,
};
use support::{core_with, Reply, TestServer};

static SCHEMES: [(&str, SecuritySchemeSpec); 6] = [
    ("bearer", SecuritySchemeSpec::HttpBearer),
    ("basic", SecuritySchemeSpec::HttpBasic),
    ("header", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Header, name: "X-API-Key" }),
    ("query", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Query, name: "api_key" }),
    ("cookie", SecuritySchemeSpec::ApiKey { location: ApiKeyLocation::Cookie, name: "session" }),
    ("oauth2", SecuritySchemeSpec::OAuth2 { token_url: Some("/token"), refresh_url: None }),
];

const fn scheme(name: &'static str) -> SecurityScheme {
    SecurityScheme { name, scopes: &[] }
}

const fn secured(security: &'static [SecurityRequirement]) -> OperationSpec {
    OperationSpec {
        operation_name: "secured",
        method: Method::GET,
        path: "/secured",
        tags: &[],
        security,
        params: &[],
        body: None,
        body_media_type: None,
        responses: &[("200", ResponseKind::Json)],
    }
}

static BEARER: OperationSpec = secured(&[SecurityRequirement { schemes: &[scheme("bearer")] }]);
static BASIC: OperationSpec = secured(&[SecurityRequirement { schemes: &[scheme("basic")] }]);
static KEYS: OperationSpec = secured(&[SecurityRequirement { schemes: &[scheme("header"), scheme("query"), scheme("cookie")] }]);
static OPTIONAL: OperationSpec =
    secured(&[SecurityRequirement { schemes: &[] }, SecurityRequirement { schemes: &[scheme("bearer")] }]);
static FALLBACK: OperationSpec = secured(&[
    SecurityRequirement { schemes: &[scheme("bearer"), scheme("header")] },
    SecurityRequirement { schemes: &[scheme("basic")] },
]);
static OAUTH: OperationSpec =
    secured(&[SecurityRequirement { schemes: &[SecurityScheme { name: "oauth2", scopes: &["read"] }] }]);
static DIGEST: OperationSpec = secured(&[SecurityRequirement { schemes: &[scheme("digest")] }]);

#[derive(Default)]
struct Auth {
    bearer: Option<TokenValue>,
    basic: Option<BasicValue>,
    header: Option<TokenValue>,
    query: Option<TokenValue>,
    cookie: Option<TokenValue>,
    oauth2: Option<OAuth2Value>,
}

impl AuthConfig for Auth {
    fn get(&self, scheme: &str) -> Option<AuthValue<'_>> {
        match scheme {
            "bearer" => self.bearer.as_ref().map(AuthValue::Token),
            "basic" => self.basic.as_ref().map(AuthValue::Basic),
            "header" => self.header.as_ref().map(AuthValue::Token),
            "query" => self.query.as_ref().map(AuthValue::Token),
            "cookie" => self.cookie.as_ref().map(AuthValue::Token),
            "oauth2" => self.oauth2.as_ref().map(AuthValue::OAuth2),
            _ => None,
        }
    }
}

fn options(server: &TestServer, auth: Auth) -> ClientOptions {
    ClientOptions { base_url: server.url.clone(), auth: Some(Arc::new(auth)), ..ClientOptions::default() }
}

async fn call(options: ClientOptions, op: &'static OperationSpec) -> Result<(), Error> {
    core_with(options, &SCHEMES)
        .send::<serde_json::Value, ()>(op, RequestValues::new(), decode_json, RequestOptions::new())
        .await
        .map(|_| ())
}

fn ok() -> TestServer {
    TestServer::replying(Reply::json(200, "{}"))
}

#[tokio::test]
async fn applies_bearer_from_provider_on_every_send() {
    let server = ok();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let token = TokenValue::provider(move || {
        let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
        async move { format!("token-{n}") }
    });
    let options = options(&server, Auth { bearer: Some(token), ..Auth::default() });
    call(options.clone(), &BEARER).await.unwrap();
    call(options, &BEARER).await.unwrap();
    let tokens: Vec<_> = server.requests().iter().map(|r| r.header("authorization").unwrap().to_owned()).collect();
    assert_eq!(tokens, ["Bearer token-1", "Bearer token-2"]);
}

#[tokio::test]
async fn applies_basic_with_utf8() {
    let server = ok();
    call(options(&server, Auth { basic: Some(BasicValue::new("user", "päss")), ..Auth::default() }), &BASIC).await.unwrap();
    assert_eq!(server.last().header("authorization"), Some("Basic dXNlcjpww6Rzcw=="));
}

#[tokio::test]
async fn applies_api_key_in_header_query_cookie() {
    let server = ok();
    let auth = Auth { header: Some("h".into()), query: Some("q &".into()), cookie: Some("c;1".into()), ..Auth::default() };
    let mut options = options(&server, auth);
    options.headers.set("Cookie", "theme=dark; session=old");
    call(options, &KEYS).await.unwrap();
    let request = server.last();
    assert_eq!(request.header("x-api-key"), Some("h"));
    assert_eq!(request.query(), "api_key=q%20%26");
    assert_eq!(request.header("cookie"), Some("theme=dark; session=c%3B1"));
}

#[tokio::test]
async fn auth_error_before_sending_when_required_auth_is_missing() {
    let server = ok();
    let error = call(options(&server, Auth::default()), &BEARER).await.unwrap_err();
    let Error::Auth(auth) = error else { panic!("{error:?}") };
    assert_eq!(auth.schemes, ["bearer"]);
    // AND requirement partially configured → next alternative; none satisfiable → the first one's missing schemes.
    let error = call(options(&server, Auth { bearer: Some("t".into()), ..Auth::default() }), &FALLBACK).await.unwrap_err();
    let Error::Auth(auth) = error else { panic!("{error:?}") };
    assert_eq!(auth.schemes, ["header"]);
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn selects_alternatives_and_optional_auth() {
    let server = ok();
    call(options(&server, Auth { basic: Some(BasicValue::new("u", "p")), ..Auth::default() }), &FALLBACK).await.unwrap();
    assert!(server.last().header("authorization").unwrap().starts_with("Basic "));
    call(options(&server, Auth::default()), &OPTIONAL).await.unwrap();
    assert_eq!(server.last().header("authorization"), None);
    call(options(&server, Auth { bearer: Some("t".into()), ..Auth::default() }), &OPTIONAL).await.unwrap();
    assert_eq!(server.last().header("authorization"), Some("Bearer t"));
}

#[tokio::test]
async fn failing_provider_is_an_auth_error_for_its_scheme() {
    let server = ok();
    let token = TokenValue::try_provider(|| async { Err::<String, _>("vault is sealed") });
    let error = call(options(&server, Auth { bearer: Some(token), ..Auth::default() }), &BEARER).await.unwrap_err();
    let Error::Auth(auth) = error else { panic!("{error:?}") };
    assert_eq!(auth.schemes, ["bearer"]);
    assert!(auth.message.contains("vault is sealed"), "{}", auth.message);
}

#[tokio::test]
async fn custom_auth_covers_unknown_scheme() {
    let server = ok();
    let options = ClientOptions {
        base_url: server.url.clone(),
        custom_auth: Some(Arc::new(|req: &mut ApiRequest, ctx: &CallContext| {
            req.headers.set("Authorization", format!("Digest for {}", ctx.operation_name));
            Ok(())
        })),
        ..ClientOptions::default()
    };
    call(options, &DIGEST).await.unwrap();
    assert_eq!(server.last().header("authorization"), Some("Digest for secured"));
}

#[tokio::test]
async fn retries_once_on_401_with_managed_token() {
    let issued = Arc::new(AtomicUsize::new(0));
    let counter = issued.clone();
    let server = TestServer::start(move |req| match req.path() {
        "/token" => {
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            Reply::json(200, &format!(r#"{{"access_token":"t{n}","expires_in":3600}}"#))
        }
        _ if req.header("authorization") == Some("Bearer t1") => Reply::json(401, "{}"),
        _ => Reply::json(200, "{}"),
    });
    let oauth2 = OAuth2Value::client_credentials(OAuth2ClientCredentials::new("id", "secret"));
    call(options(&server, Auth { oauth2: Some(oauth2), ..Auth::default() }), &OAUTH).await.unwrap();
    let paths: Vec<_> =
        server.requests().iter().map(|r| (r.path().to_owned(), r.header("authorization").map(str::to_owned))).collect();
    assert_eq!(paths[0].0, "/token");
    assert_eq!(paths[1], ("/secured".to_owned(), Some("Bearer t1".to_owned())));
    assert_eq!(paths[2].0, "/token");
    assert_eq!(paths[3], ("/secured".to_owned(), Some("Bearer t2".to_owned())));
    assert_eq!(paths.len(), 4);
    let token_request = &server.requests()[0];
    assert_eq!(token_request.text(), "grant_type=client_credentials&scope=read");
    assert_eq!(token_request.header("authorization"), Some("Basic aWQ6c2VjcmV0"));
}

#[tokio::test]
async fn reapplies_fresh_token_when_middleware_resends() {
    let server = TestServer::start(|req| {
        if req.header("authorization") == Some("Bearer 1") {
            Reply::json(401, "{}")
        } else {
            Reply::json(200, "{}")
        }
    });
    let n = Arc::new(AtomicUsize::new(0));
    let counter = n.clone();
    let token = TokenValue::provider(move || {
        let value = counter.fetch_add(1, Ordering::SeqCst) + 1;
        async move { value.to_string() }
    });
    let mut options = options(&server, Auth { bearer: Some(token), ..Auth::default() });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    options.middleware.push(Arc::new(archon_runtime::Retry401Middleware::new(move |ctx, _| {
        sink.lock().unwrap().push(ctx.attempt());
        Box::pin(async { true })
    })));
    call(options, &BEARER).await.unwrap();
    let auth: Vec<_> = server.requests().iter().map(|r| r.header("authorization").unwrap().to_owned()).collect();
    assert_eq!(auth, ["Bearer 1", "Bearer 2"]);
    assert_eq!(*seen.lock().unwrap(), [1]);
}
