mod support;

use archon_edge_cases::core::Error;
use support::client;

#[tokio::test]
async fn decodes_text_plain_as_a_string() {
    assert_eq!(client().responses().get_text().await.unwrap().data, "hello, archon");
}

#[tokio::test]
async fn decodes_octet_stream_as_bytes() {
    let bytes = client().responses().get_binary().await.unwrap().data;
    assert_eq!(bytes.len(), 256);
    assert_eq!((bytes[0], bytes[255]), (0x00, 0xff));
}

#[tokio::test]
async fn returns_without_data_for_204_no_content() {
    let response = client().responses().get_empty().await.unwrap();
    assert_eq!(response.status, 204);
}

// As in Kotlin (and unlike C#), the declared type is not optional, so an empty body cannot become a value.
#[tokio::test]
async fn returns_a_decode_error_for_an_empty_body_declared_as_non_null_json() {
    let error = client().responses().get_empty_json().await.unwrap_err();
    let Error::Decode(decode) = error else { panic!("{error:?}") };
    assert_eq!(decode.status, 200);
    assert_eq!(decode.raw_body, "");
}
