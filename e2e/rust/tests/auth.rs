mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use archon_edge_cases::core::{BasicValue, Error, OAuth2ClientCredentials, OAuth2RefreshToken, OAuth2Value, TokenValue};
use archon_edge_cases::services::auth::AuthBearerError;
use archon_edge_cases::{ApiAuth, ApiClient};
use support::{builder, client, request_count, stats};

fn with(auth: ApiAuth) -> ApiClient {
    builder().auth(auth).build()
}

fn client_credentials() -> OAuth2Value {
    OAuth2Value::client_credentials(OAuth2ClientCredentials::new("client-id", "client-secret"))
}

#[tokio::test]
async fn bearer() {
    let response = with(ApiAuth { bearer_auth: Some("test-token".into()), ..ApiAuth::default() }).auth().auth_bearer().await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.data.headers["authorization"], "Bearer test-token");
}

#[tokio::test]
async fn basic() {
    let client = with(ApiAuth { basic_auth: Some(BasicValue::new("user", "pass")), ..ApiAuth::default() });
    assert_eq!(client.auth().auth_basic().await.unwrap().status, 200);
}

#[tokio::test]
async fn api_key_in_a_header() {
    let client = with(ApiAuth { api_key_header: Some("test-key".into()), ..ApiAuth::default() });
    assert_eq!(client.auth().auth_api_key_header().await.unwrap().data.headers["x-api-key"], "test-key");
}

#[tokio::test]
async fn api_key_in_the_query() {
    let client = with(ApiAuth { api_key_query: Some(TokenValue::provider(|| async { "test-key".to_owned() })), ..ApiAuth::default() });
    assert_eq!(client.auth().auth_api_key_query().await.unwrap().data.query, "api_key=test-key");
}

#[tokio::test]
async fn api_key_in_a_cookie() {
    let client = with(ApiAuth { api_key_cookie: Some("test-key".into()), ..ApiAuth::default() });
    let cookies = client.auth().auth_api_key_cookie().await.unwrap().data.cookies;
    assert_eq!(cookies.len(), 1);
    assert_eq!(cookies["session"], "test-key");
}

#[tokio::test]
async fn rejects_a_wrong_credential_with_a_typed_401() {
    let error = with(ApiAuth { bearer_auth: Some("wrong".into()), ..ApiAuth::default() }).auth().auth_bearer().await.unwrap_err();
    let Error::Api(api) = error else { panic!("{error:?}") };
    assert_eq!(api.status, 401);
    let Some(AuthBearerError::Status401(body)) = &api.body else { panic!("{api:?}") };
    assert_eq!(body.code, 401);
    assert!(!body.message.is_empty());
}

#[tokio::test]
async fn returns_an_auth_error_without_sending_when_required_auth_is_missing() {
    let before = request_count("/auth/bearer").await;
    let error = client().auth().auth_bearer().await.unwrap_err();
    let Error::Auth(auth) = error else { panic!("{error:?}") };
    assert_eq!(auth.schemes, ["bearerAuth"]);
    assert_eq!(request_count("/auth/bearer").await, before);
}

#[tokio::test]
async fn sends_anonymously_when_auth_is_optional_and_not_configured() {
    assert!(!client().auth().auth_optional().await.unwrap().data.headers.contains_key("authorization"));
}

#[tokio::test]
async fn uses_the_credential_for_optional_auth_when_it_is_configured() {
    let echo = with(ApiAuth { bearer_auth: Some("test-token".into()), ..ApiAuth::default() }).auth().auth_optional().await.unwrap().data;
    assert_eq!(echo.headers["authorization"], "Bearer test-token");
}

#[tokio::test]
async fn requires_every_scheme_of_an_and_requirement() {
    let before = request_count("/auth/and").await;
    let partial = with(ApiAuth { bearer_auth: Some("test-token".into()), ..ApiAuth::default() });
    assert!(matches!(partial.auth().auth_and().await, Err(Error::Auth(_))));
    assert_eq!(request_count("/auth/and").await, before);

    let both = with(ApiAuth { bearer_auth: Some("test-token".into()), api_key_header: Some("test-key".into()), ..ApiAuth::default() });
    assert_eq!(both.auth().auth_and().await.unwrap().status, 200);
}

#[tokio::test]
async fn oauth2_obtains_a_token_with_client_credentials_from_the_relative_token_url() {
    let before = stats().await;
    let echo = with(ApiAuth { oauth2: Some(client_credentials()), ..ApiAuth::default() }).auth().auth_o_auth2().await.unwrap().data;
    assert!(echo.headers["authorization"].starts_with("Bearer "));
    assert_eq!(stats().await.tokens_issued, before.tokens_issued + 1);
}

#[tokio::test]
async fn oauth2_obtains_a_token_with_the_refresh_token_grant() {
    let refreshed = Arc::new(Mutex::new(Vec::new()));
    let sink = refreshed.clone();
    let grant = OAuth2RefreshToken {
        client_secret: Some("client-secret".into()),
        on_refreshed: Some(Arc::new(move |tokens| sink.lock().unwrap().push(tokens.refresh_token.clone()))),
        ..OAuth2RefreshToken::new("test-refresh-token", "client-id")
    };
    let client = with(ApiAuth { oauth2: Some(OAuth2Value::refresh_token(grant)), ..ApiAuth::default() });
    assert_eq!(client.auth().auth_o_auth2().await.unwrap().status, 200);
    let refreshed = refreshed.lock().unwrap();
    assert_eq!(refreshed.len(), 1);
    assert_ne!(refreshed[0].as_deref(), Some("test-refresh-token"));
}

#[tokio::test]
async fn oauth2_renews_the_token_before_it_expires_instead_of_waiting_for_a_401() {
    let client = with(ApiAuth { oauth2: Some(client_credentials()), ..ApiAuth::default() });
    let before = stats().await;

    let first = client.auth().auth_o_auth2().await.unwrap().data;
    // The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let second = client.auth().auth_o_auth2().await.unwrap().data;
    assert_ne!(first.headers["authorization"], second.headers["authorization"]);

    let after = stats().await;
    assert_eq!(after.tokens_issued - before.tokens_issued, 2);
    assert_eq!(after.count("/auth/oauth2") - before.count("/auth/oauth2"), 2);
}

#[tokio::test]
async fn oauth2_issues_a_single_token_for_concurrent_requests_on_a_cold_client() {
    let client = with(ApiAuth { oauth2: Some(client_credentials()), ..ApiAuth::default() });
    let before = stats().await;
    let tasks: Vec<_> = (0..5).map(|_| tokio::spawn(client.auth().auth_o_auth2().send())).collect();
    let mut tokens = Vec::new();
    for task in tasks {
        tokens.push(task.await.unwrap().unwrap().data.headers["authorization"].clone());
    }
    tokens.dedup();
    assert_eq!(tokens.len(), 1);
    assert_eq!(stats().await.tokens_issued - before.tokens_issued, 1);
}
