mod support;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use archon_runtime::{OAuth2ClientAuth, OAuth2ClientCredentials, OAuth2RefreshToken, OAuth2TokenManager, OAuth2Value};
use support::{Reply, TestServer};

/// A token endpoint issuing `t1`, `t2`, ... that live `lifetime` seconds (and rotate refresh tokens `r1`, `r2`, ...).
fn token_server(lifetime: u32, delay: Duration) -> (TestServer, Arc<AtomicUsize>) {
    let issued = Arc::new(AtomicUsize::new(0));
    let counter = issued.clone();
    let server = TestServer::start(move |_| {
        let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
        Reply::json(200, &format!(r#"{{"access_token":"t{n}","refresh_token":"r{n}","expires_in":{lifetime},"scope":"read"}}"#))
            .delay(delay)
    });
    (server, issued)
}

fn manager(server: &TestServer, config: OAuth2Value) -> OAuth2TokenManager {
    OAuth2TokenManager::new(reqwest::Client::new(), config, Some(format!("{}/token", server.url)), None, "oauth2")
}

fn credentials() -> OAuth2Value {
    OAuth2Value::client_credentials(OAuth2ClientCredentials::new("client", "secret"))
}

#[tokio::test]
async fn fetches_client_credentials_with_basic_or_post_client_auth() {
    let (server, _) = token_server(3600, Duration::ZERO);
    let mut grant = OAuth2ClientCredentials::new("client", "secret");
    grant.scopes = vec!["write".into()];
    assert_eq!(
        manager(&server, OAuth2Value::client_credentials(grant.clone())).get_token(&["read", "write"]).await.unwrap(),
        "t1"
    );
    let request = server.last();
    assert_eq!(request.method, "POST");
    assert_eq!(request.header("content-type"), Some("application/x-www-form-urlencoded"));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.header("authorization"), Some("Basic Y2xpZW50OnNlY3JldA=="));
    assert_eq!(request.text(), "grant_type=client_credentials&scope=read+write");

    grant.client_auth = OAuth2ClientAuth::Post;
    manager(&server, OAuth2Value::client_credentials(grant)).get_token(&[]).await.unwrap();
    let request = server.last();
    assert_eq!(request.header("authorization"), None);
    assert_eq!(request.text(), "grant_type=client_credentials&scope=write&client_id=client&client_secret=secret");
}

#[tokio::test]
async fn caches_until_30s_before_expiry() {
    let (server, issued) = token_server(60, Duration::ZERO);
    let now = Arc::new(AtomicU64::new(1_000_000));
    let clock = now.clone();
    let manager = manager(&server, credentials()).with_clock(move || clock.load(Ordering::SeqCst));
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t1");
    now.fetch_add(29_000, Ordering::SeqCst);
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t1");
    now.fetch_add(1_000, Ordering::SeqCst);
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t2");
    // Scopes are cached separately.
    assert_eq!(manager.get_token(&["other"]).await.unwrap(), "t3");
    assert_eq!(issued.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn single_flight_for_concurrent_calls() {
    let (server, issued) = token_server(3600, Duration::from_millis(100));
    let manager = Arc::new(manager(&server, credentials()));
    let tasks: Vec<_> = (0..5)
        .map(|_| {
            tokio::spawn({
                let manager = manager.clone();
                async move { manager.get_token(&["read"]).await.unwrap() }
            })
        })
        .collect();
    for task in tasks {
        assert_eq!(task.await.unwrap(), "t1");
    }
    assert_eq!(issued.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn waiters_share_a_token_that_already_falls_inside_the_leeway() {
    // expires_in 2 s is inside the 30 s leeway: every token is due for renewal as soon as it arrives.
    let (server, issued) = token_server(2, Duration::from_millis(100));
    let manager = Arc::new(manager(&server, credentials()));
    let tasks: Vec<_> = (0..5)
        .map(|_| {
            let manager = manager.clone();
            tokio::spawn(async move { manager.get_token(&[]).await.unwrap() })
        })
        .collect();
    for task in tasks {
        assert_eq!(task.await.unwrap(), "t1");
    }
    assert_eq!(issued.load(Ordering::SeqCst), 1);
    // A later call renews it.
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t2");
}

#[tokio::test]
async fn dropped_waiter_does_not_fail_the_others() {
    let (server, issued) = token_server(3600, Duration::from_millis(200));
    let manager = Arc::new(manager(&server, credentials()));
    let first = tokio::spawn({
        let manager = manager.clone();
        async move { manager.get_token(&[]).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let second = tokio::spawn({
        let manager = manager.clone();
        async move { manager.get_token(&[]).await }
    });
    first.abort();
    let token = second.await.unwrap().unwrap();
    assert!(token == "t1" || token == "t2", "{token}");
    assert!(issued.load(Ordering::SeqCst) <= 2);
}

#[tokio::test]
async fn refresh_grant_rotates_token_and_calls_on_refreshed() {
    let (server, _) = token_server(1, Duration::ZERO);
    let refreshed = Arc::new(Mutex::new(Vec::new()));
    let sink = refreshed.clone();
    let mut grant = OAuth2RefreshToken::new("r0", "client");
    grant.on_refreshed = Some(Arc::new(move |tokens| sink.lock().unwrap().push(tokens.refresh_token.clone().unwrap())));
    let manager = manager(&server, OAuth2Value::refresh_token(grant));
    assert_eq!(manager.get_token(&["ignored"]).await.unwrap(), "t1");
    assert_eq!(server.last().text(), "grant_type=refresh_token&refresh_token=r0&client_id=client");
    // expires_in 1 s is inside the 30 s leeway: the next call refreshes with the rotated token.
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t2");
    assert_eq!(server.last().text(), "grant_type=refresh_token&refresh_token=r1&client_id=client");
    assert_eq!(*refreshed.lock().unwrap(), ["r1", "r2"]);
}

#[tokio::test]
async fn resolves_relative_token_url_against_base_url() {
    let (server, _) = token_server(3600, Duration::ZERO);
    let manager = OAuth2TokenManager::new(
        reqwest::Client::new(),
        credentials(),
        Some("/oauth/token".into()),
        Some(format!("{}/api/", server.url)),
        "oauth2",
    );
    manager.get_token(&[]).await.unwrap();
    assert_eq!(server.last().path(), "/oauth/token");

    let manager = OAuth2TokenManager::new(reqwest::Client::new(), credentials(), Some("/oauth/token".into()), None, "oauth2");
    let error = manager.get_token(&[]).await.unwrap_err();
    assert_eq!(error.schemes, ["oauth2"]);
}

#[tokio::test]
async fn auth_error_on_token_endpoint_failure() {
    for reply in [Reply::json(500, "{}"), Reply::json(200, "{nope"), Reply::json(200, r#"{"token_type":"bearer"}"#)] {
        let server = TestServer::replying(reply);
        let error = manager(&server, credentials()).get_token(&[]).await.unwrap_err();
        assert_eq!(error.schemes, ["oauth2"], "{error:?}");
    }
    let server = TestServer::replying(Reply::json(200, "{}").delay(Duration::from_millis(300)));
    let error = manager(&server, credentials()).with_timeout(Some(Duration::from_millis(50))).get_token(&[]).await.unwrap_err();
    assert!(error.message.contains("timed out"), "{}", error.message);
}

#[tokio::test]
async fn invalidate_drops_only_the_rejected_token() {
    let (server, _) = token_server(3600, Duration::ZERO);
    let manager = manager(&server, credentials());
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t1");
    manager.invalidate(Some("stale"));
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t1");
    manager.invalidate(Some("t1"));
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t2");
    manager.invalidate(None);
    assert_eq!(manager.get_token(&[]).await.unwrap(), "t3");
    assert!(manager.managed());
}
