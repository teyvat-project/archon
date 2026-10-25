mod support;

use archon_edge_cases::core::Error;
use archon_edge_cases::services::errors::GetErrorError;
use support::client;

async fn error_body(status: i64) -> (u16, Option<GetErrorError>) {
    match client().errors().get_error(status).await {
        Err(Error::Api(api)) => (api.status, api.body),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn returns_the_success_body_for_200() {
    assert!(client().errors().get_error(200).await.unwrap().data.ok);
}

#[tokio::test]
async fn returns_a_typed_error_body_for_404() {
    let (status, body) = error_body(404).await;
    assert_eq!(status, 404);
    let Some(GetErrorError::Status404(body)) = body else { panic!("{body:?}") };
    assert_eq!((body.message.as_str(), body.resource.as_str()), ("Not found", "errors/404"));
}

#[tokio::test]
async fn returns_the_400_validation_error_body() {
    let (status, body) = error_body(400).await;
    assert_eq!(status, 400);
    let Some(GetErrorError::Status400(body)) = body else { panic!("{body:?}") };
    assert_eq!(body.message, "Validation failed");
    assert_eq!(body.fields.len(), 1);
    assert_eq!((body.fields[0].name.as_str(), body.fields[0].reason.as_str()), ("status", "invalid"));
}

#[tokio::test]
async fn returns_the_default_error_body_for_any_other_status() {
    for status in [418, 500] {
        let (actual, body) = error_body(status).await;
        assert_eq!(i64::from(actual), status);
        let Some(GetErrorError::Default(body)) = body else { panic!("{body:?}") };
        assert_eq!(body.code, status);
    }
}
