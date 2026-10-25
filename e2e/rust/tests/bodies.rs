mod support;

use std::collections::HashMap;

use archon_edge_cases::core::ApiFile;
use archon_edge_cases::models::{EchoFormBody, EchoMultipartBody, JsonPayload, Nested, Node};
use support::{client, strings};

#[tokio::test]
async fn sends_a_json_body() {
    let payload = JsonPayload { name: "archon".into(), count: 3, tags: Some(strings(&["a", "b"])), note: None, nested: Some(Nested { flag: Some(true) }) };
    let echo = client().echo().echo_json(payload.clone()).await.unwrap().data;
    assert_eq!(echo.method, "POST");
    assert_eq!(echo.content_type.as_deref(), Some("application/json"));
    let body = echo.body.unwrap();
    assert_eq!(serde_json::from_str::<JsonPayload>(&body).unwrap(), payload);
    // Optional nulls are not written (the "unset" vs "null" distinction is out of scope).
    assert!(!body.contains("note"), "{body}");
}

#[tokio::test]
async fn sends_a_url_encoded_form_body_with_repeated_array_fields() {
    let echo = client().echo().echo_form(EchoFormBody { name: "a b&c".into(), count: Some(2), tags: Some(strings(&["x", "y"])) }).await.unwrap().data;
    assert_eq!(echo.content_type.as_deref(), Some("application/x-www-form-urlencoded"));
    assert_eq!(echo.body.as_deref(), Some("name=a+b%26c&count=2&tags=x&tags=y"));
}

#[tokio::test]
async fn sends_a_multipart_body_with_file_names_and_sizes() {
    let body = EchoMultipartBody {
        title: "hello".into(),
        file: ApiFile::new(vec![0; 10]).with_file_name("data.bin").with_content_type("application/octet-stream"),
        attachments: Some(vec![ApiFile::new(b"abc".to_vec()).with_file_name("a.txt"), ApiFile::new(b"hello".to_vec()).with_file_name("b.txt")]),
    };
    let echo = client().echo().echo_multipart(body).await.unwrap().data;
    let content_type = echo.content_type.unwrap();
    assert!(content_type.starts_with("multipart/form-data; boundary="), "{content_type}");
    assert_eq!(echo.body.as_deref(), Some(r#"{"title":"hello"}"#));
    let files: Vec<_> = echo.files.unwrap().into_iter().map(|f| (f.field, f.name, f.size)).collect();
    assert_eq!(
        files,
        [("file".to_owned(), "data.bin".to_owned(), 10), ("attachments".to_owned(), "a.txt".to_owned(), 3), ("attachments".to_owned(), "b.txt".to_owned(), 5)]
    );
}

#[tokio::test]
async fn sends_a_binary_body() {
    let echo = client().echo().echo_binary(ApiFile::new(b"raw bytes".to_vec())).await.unwrap().data;
    assert_eq!(echo.content_type.as_deref(), Some("application/octet-stream"));
    assert_eq!(echo.headers["content-length"], "9");
    assert_eq!(echo.body.as_deref(), Some("raw bytes"));
}

#[tokio::test]
async fn sends_a_plain_text_body() {
    let echo = client().echo().echo_text("hello, text").await.unwrap().data;
    assert_eq!(echo.content_type.as_deref(), Some("text/plain"));
    assert_eq!(echo.body.as_deref(), Some("hello, text"));
}

fn node(name: &str, children: Vec<Node>) -> Node {
    Node { id: "placeholder".into(), name: name.into(), labels: None, children, parent_id: None }
}

#[tokio::test]
async fn round_trips_a_recursive_all_of_tree_the_server_assigning_ids() {
    let tree = Node {
        labels: Some(HashMap::from([("env".to_owned(), "test".to_owned())])),
        ..node("root", vec![node("a", vec![node("a1", vec![])]), node("b", vec![])])
    };
    let response = client().nodes().create_node(tree).await.unwrap();
    assert_eq!(response.status, 201);
    let root = response.data;
    assert_eq!(root.id, "n1");
    assert_eq!(root.parent_id, None);
    assert_eq!(root.name, "root");
    assert_eq!(root.labels.unwrap()["env"], "test");
    assert_eq!(root.children.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["n2", "n4"]);
    assert!(root.children.iter().all(|c| c.parent_id.as_deref() == Some("n1")));
    let a1 = &root.children[0].children[0];
    assert_eq!((a1.id.as_str(), a1.parent_id.as_deref(), a1.name.as_str()), ("n3", Some("n2"), "a1"));
    assert!(root.children[1].children.is_empty());
}
