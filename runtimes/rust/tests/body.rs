mod support;

use archon_runtime::{
    decode_json, ApiBody, ApiFile, ApiRequest, BodyKind, Error, Method, MultipartBody, OperationSpec, RequestOptions,
    RequestValues, ResponseKind,
};
use serde::Serialize;
use support::{core, Reply, TestServer};

const fn post(path: &'static str, body: BodyKind, media: &'static str) -> OperationSpec {
    OperationSpec {
        operation_name: "post",
        method: Method::POST,
        path,
        tags: &[],
        security: &[],
        params: &[],
        body: Some(body),
        body_media_type: Some(media),
        responses: &[("200", ResponseKind::Json)],
    }
}

static JSON: OperationSpec = post("/json", BodyKind::Json, "application/json");
static FORM: OperationSpec = post("/form", BodyKind::Form, "application/x-www-form-urlencoded");
static MULTIPART: OperationSpec = post("/multipart", BodyKind::Multipart, "multipart/form-data");
static BINARY: OperationSpec = post("/binary", BodyKind::Binary, "application/octet-stream");
static TEXT: OperationSpec = post("/text", BodyKind::Text, "text/plain");

#[derive(Serialize)]
struct Payload {
    name: &'static str,
    count: i32,
    tags: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

async fn send(server: &TestServer, op: &'static OperationSpec, values: RequestValues) {
    let result: Result<_, Error> =
        core(&server.url).send(op, values, decode_json::<serde_json::Value>, RequestOptions::new()).await;
    result.unwrap();
}

#[tokio::test]
async fn encodes_json_with_exact_content_type() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    let payload = Payload { name: "a", count: 1, tags: vec!["x"], note: None };
    send(&server, &JSON, RequestValues::new().json_body(&payload)).await;
    let request = server.last();
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.text(), r#"{"name":"a","count":1,"tags":["x"]}"#);
}

#[tokio::test]
async fn encodes_form_with_repeated_array_fields() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    let payload = Payload { name: "a b&c", count: 2, tags: vec!["x", "y"], note: None };
    send(&server, &FORM, RequestValues::new().form_body(&payload)).await;
    let request = server.last();
    assert_eq!(request.header("content-type"), Some("application/x-www-form-urlencoded"));
    assert_eq!(request.text(), "name=a+b%26c&count=2&tags=x&tags=y");
}

#[tokio::test]
async fn encodes_multipart_with_quoted_names_and_filenames() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    let file = ApiFile::new(b"abc".to_vec()).with_file_name("a\"b.txt").with_content_type("text/plain");
    let multipart = MultipartBody::new()
        .add_json("title", "hello")
        .add_json("tags", &["x", "y"])
        .add_json("missing", &None::<String>)
        .add_file("file", &file)
        .add_files("more", &[ApiFile::new(b"z".to_vec())]);
    let content_type = multipart.content_type();
    send(&server, &MULTIPART, RequestValues::new().multipart(multipart)).await;
    let request = server.last();
    assert_eq!(request.header("content-type"), Some(content_type.as_str()));
    let b = content_type.split("boundary=").nth(1).unwrap();
    let expected = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nhello\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"tags\"\r\n\r\nx\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"tags\"\r\n\r\ny\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22b.txt\"\r\nContent-Type: text/plain\r\n\r\nabc\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"more\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\nz\r\n\
         --{b}--\r\n"
    );
    assert_eq!(request.text(), expected);
}

#[tokio::test]
async fn sends_binary_and_text_bodies_with_the_operation_media_type() {
    let server = TestServer::replying(Reply::json(200, "{}"));
    send(&server, &BINARY, RequestValues::new().binary_body(ApiFile::new(b"raw bytes".to_vec()).with_content_type("image/png")))
        .await;
    let request = server.last();
    assert_eq!(request.header("content-type"), Some("application/octet-stream"));
    assert_eq!(request.header("content-length"), Some("9"));
    assert_eq!(request.text(), "raw bytes");

    send(&server, &TEXT, RequestValues::new().text_body("hello, text")).await;
    let request = server.last();
    assert_eq!(request.header("content-type"), Some("text/plain"));
    assert_eq!(request.text(), "hello, text");
}

#[test]
fn stream_body_is_not_replayable() {
    let mut request = ApiRequest::new(Method::POST, "http://x.test/");
    request.body = Some(ApiBody::Stream(reqwest::Body::from("data")));
    assert!(!request.replayable());
    assert!(request.try_clone().is_none());
    request.body = Some(ApiBody::Bytes(b"data".to_vec()));
    assert!(request.replayable());
    assert_eq!(request.try_clone().unwrap().body.unwrap().as_bytes(), Some(&b"data"[..]));
}

#[test]
fn multipart_body_is_deterministic() {
    let multipart = MultipartBody::new().add_text("a", "1").add_file("f", &ApiFile::new(vec![0, 1, 2]));
    assert_eq!(multipart.to_bytes(), multipart.clone().to_bytes());
    assert_ne!(MultipartBody::new().content_type(), MultipartBody::new().content_type());
}

#[test]
fn api_file_serializes_as_base64() {
    for (bytes, text) in
        [(&b""[..], ""), (b"f", "Zg=="), (b"fo", "Zm8="), (b"foo", "Zm9v"), (b"foob", "Zm9vYg=="), (&[0xff, 0xfe][..], "//4=")]
    {
        let json = serde_json::to_string(&ApiFile::new(bytes.to_vec())).unwrap();
        assert_eq!(json, format!("\"{text}\""));
        let back: ApiFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.content, bytes);
    }
    let unpadded: ApiFile = serde_json::from_str("\"Zm8\"").unwrap();
    assert_eq!(unpadded.content, b"fo");
    assert!(serde_json::from_str::<ApiFile>("\"Zm9v!\"").is_err());
}
