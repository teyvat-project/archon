mod support;

use archon_edge_cases::ApiAuth;
use support::{builder, origin, secondary_url};

#[tokio::test]
async fn drops_credentials_when_a_redirect_crosses_origins() {
    let client = builder()
        .auth(ApiAuth { api_key_header: Some("test-key".into()), ..ApiAuth::default() })
        .header("Authorization", "Bearer test-token")
        .build();
    let response = client.middleware().redirect_cross_origin().await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(origin(&response.url), origin(&secondary_url()));
    assert_eq!(response.data.path, "/echo/headers");
    assert!(!response.data.headers.contains_key("x-api-key"));
    assert!(!response.data.headers.contains_key("authorization"));
}
