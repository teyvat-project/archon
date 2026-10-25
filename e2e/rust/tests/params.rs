mod support;

use std::collections::HashMap;

use archon_edge_cases::models::{EchoPathStylesMatrix, EchoQueryStylesFilter};
use support::{client, strings};

#[tokio::test]
async fn serializes_all_path_styles() {
    let echo = client().echo().echo_path_styles(strings(&["a", "b"]), strings(&["a", "b"]), EchoPathStylesMatrix { x: 1, y: 2 }).await.unwrap().data;
    assert_eq!(echo.method, "GET");
    assert_eq!(echo.path, "/echo/path/a,b/.a.b/;x=1;y=2");
    assert_eq!(echo.query, "");
}

#[tokio::test]
async fn percent_encodes_reserved_characters() {
    let echo =
        client().echo().echo_path_styles(strings(&["a/b?c#d e", "日本"]), strings(&["x"]), EchoPathStylesMatrix { x: 1, y: 2 }).await.unwrap().data;
    assert_eq!(echo.path, "/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2");
}

#[tokio::test]
async fn serializes_all_query_styles() {
    let echo = client()
        .echo()
        .echo_query_styles()
        .form_exploded(strings(&["a", "b"]))
        .form_flat(strings(&["a", "b"]))
        .spaced(strings(&["a", "b"]))
        .piped(vec![1, 2])
        .filter(EchoQueryStylesFilter { status: Some("active".into()), min_age: Some(3) })
        .reserved("a/b?c:d")
        .limit(10)
        .await
        .unwrap()
        .data;
    assert_eq!(echo.path, "/echo/query");
    assert_eq!(
        echo.query,
        [
            "formExploded=a&formExploded=b",
            "formFlat=a,b",
            "spaced=a%20b",
            "piped=1|2",
            "filter[status]=active&filter[minAge]=3",
            "reserved=a/b?c:d",
            "limit=10",
        ]
        .join("&")
    );
}

#[tokio::test]
async fn omits_unset_query_parameters() {
    assert_eq!(client().echo().echo_query_styles().limit(1).await.unwrap().data.query, "limit=1");
}

#[tokio::test]
async fn sends_header_array_and_cookies() {
    let echo = client().echo().echo_headers_cookies(strings(&["a", "b"]), "dark").x_trace("trace-1").tags(strings(&["x", "y"])).await.unwrap().data;
    assert_eq!(echo.headers["x-request-ids"], "a,b");
    assert_eq!(echo.headers["x-trace"], "trace-1");
    assert_eq!(echo.headers["cookie"], "theme=dark; tags=x,y");
    assert_eq!(echo.cookies, HashMap::from([("theme".to_owned(), "dark".to_owned()), ("tags".to_owned(), "x,y".to_owned())]));
}
