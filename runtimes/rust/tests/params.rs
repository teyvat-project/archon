use std::collections::BTreeMap;

use archon_runtime::{
    serialize_cookie, serialize_header, serialize_path, serialize_query, FormBody, ParamLocation, ParamSpec, ParamStyle,
    RequestValues,
};
use serde::Serialize;
use serde_json::json;

fn spec(name: &'static str, location: ParamLocation, style: ParamStyle, explode: bool) -> ParamSpec {
    ParamSpec { name, location, style, explode, allow_reserved: false }
}

/// `R=100, G=200, B=150` in that order (a struct keeps declaration order).
#[derive(Serialize)]
#[allow(non_snake_case)]
struct Rgb {
    R: i32,
    G: i32,
    B: i32,
}

const RGB: Rgb = Rgb { R: 100, G: 200, B: 150 };

fn values(location: ParamLocation, kind: &str) -> RequestValues {
    let add = |v: RequestValues, value: &dyn erased::Value| match location {
        ParamLocation::Path => value.path(v),
        ParamLocation::Query => value.query(v),
        ParamLocation::Header => value.header(v),
        ParamLocation::Cookie => value.cookie(v),
    };
    match kind {
        "string" => add(RequestValues::new(), &"blue"),
        "array" => add(RequestValues::new(), &vec!["blue", "black", "brown"]),
        _ => add(RequestValues::new(), &RGB),
    }
}

/// Lets the table pick the parameter location at run time.
mod erased {
    use archon_runtime::RequestValues;
    use serde::Serialize;

    pub trait Value {
        fn path(&self, v: RequestValues) -> RequestValues;
        fn query(&self, v: RequestValues) -> RequestValues;
        fn header(&self, v: RequestValues) -> RequestValues;
        fn cookie(&self, v: RequestValues) -> RequestValues;
    }

    impl<T: Serialize> Value for T {
        fn path(&self, v: RequestValues) -> RequestValues {
            v.path("color", self)
        }
        fn query(&self, v: RequestValues) -> RequestValues {
            v.query("color", self)
        }
        fn header(&self, v: RequestValues) -> RequestValues {
            v.header("color", self)
        }
        fn cookie(&self, v: RequestValues) -> RequestValues {
            v.cookie("color", self)
        }
    }
}

#[test]
fn serializes_path_styles() {
    let cases = [
        (ParamStyle::Matrix, false, "string", ";color=blue"),
        (ParamStyle::Matrix, false, "array", ";color=blue,black,brown"),
        (ParamStyle::Matrix, false, "object", ";color=R,100,G,200,B,150"),
        (ParamStyle::Matrix, true, "string", ";color=blue"),
        (ParamStyle::Matrix, true, "array", ";color=blue;color=black;color=brown"),
        (ParamStyle::Matrix, true, "object", ";R=100;G=200;B=150"),
        (ParamStyle::Label, false, "string", ".blue"),
        (ParamStyle::Label, false, "array", ".blue,black,brown"),
        (ParamStyle::Label, false, "object", ".R,100,G,200,B,150"),
        (ParamStyle::Label, true, "string", ".blue"),
        (ParamStyle::Label, true, "array", ".blue.black.brown"),
        (ParamStyle::Label, true, "object", ".R=100.G=200.B=150"),
        (ParamStyle::Simple, false, "string", "blue"),
        (ParamStyle::Simple, false, "array", "blue,black,brown"),
        (ParamStyle::Simple, false, "object", "R,100,G,200,B,150"),
        (ParamStyle::Simple, true, "string", "blue"),
        (ParamStyle::Simple, true, "array", "blue,black,brown"),
        (ParamStyle::Simple, true, "object", "R=100,G=200,B=150"),
    ];
    for (style, explode, kind, expected) in cases {
        let specs = [spec("color", ParamLocation::Path, style, explode)];
        let actual = serialize_path("{color}", &specs, &values(ParamLocation::Path, kind)).unwrap();
        assert_eq!(actual, expected, "{style:?} explode={explode} {kind}");
    }
}

#[test]
fn serializes_query_styles() {
    let cases = [
        (ParamStyle::Form, false, "string", "color=blue"),
        (ParamStyle::Form, false, "array", "color=blue,black,brown"),
        (ParamStyle::Form, false, "object", "color=R,100,G,200,B,150"),
        (ParamStyle::Form, true, "string", "color=blue"),
        (ParamStyle::Form, true, "array", "color=blue&color=black&color=brown"),
        (ParamStyle::Form, true, "object", "R=100&G=200&B=150"),
        (ParamStyle::SpaceDelimited, false, "array", "color=blue%20black%20brown"),
        (ParamStyle::SpaceDelimited, false, "object", "color=R%20100%20G%20200%20B%20150"),
        (ParamStyle::PipeDelimited, false, "array", "color=blue|black|brown"),
        (ParamStyle::PipeDelimited, false, "object", "color=R|100|G|200|B|150"),
        (ParamStyle::DeepObject, true, "object", "color[R]=100&color[G]=200&color[B]=150"),
    ];
    for (style, explode, kind, expected) in cases {
        let specs = [spec("color", ParamLocation::Query, style, explode)];
        assert_eq!(serialize_query(&specs, &values(ParamLocation::Query, kind)), expected, "{style:?} explode={explode} {kind}");
    }
}

#[test]
fn percent_encodes_reserved_chars_in_path_values() {
    let specs = [spec("name", ParamLocation::Path, ParamStyle::Simple, false)];
    let values = RequestValues::new().path("name", "a/b?c#d e");
    assert_eq!(serialize_path("/files/{name}", &specs, &values).unwrap(), "/files/a%2Fb%3Fc%23d%20e");
    let values = RequestValues::new().path("name", "日本");
    assert_eq!(serialize_path("/files/{name}", &specs, &values).unwrap(), "/files/%E6%97%A5%E6%9C%AC");
}

#[test]
fn allow_reserved_keeps_reserved_chars_in_query_only() {
    let query = [ParamSpec { allow_reserved: true, ..spec("reserved", ParamLocation::Query, ParamStyle::Form, true) }];
    assert_eq!(serialize_query(&query, &RequestValues::new().query("reserved", "a/b?c:d")), "reserved=a/b?c:d");
    let path = [ParamSpec { allow_reserved: true, ..spec("name", ParamLocation::Path, ParamStyle::Simple, false) }];
    assert_eq!(serialize_path("/files/{name}", &path, &RequestValues::new().path("name", "a/b")).unwrap(), "/files/a%2Fb");
}

#[test]
fn keeps_encode_uri_component_safe_chars() {
    let specs = [spec("q", ParamLocation::Query, ParamStyle::Form, true)];
    assert_eq!(serialize_query(&specs, &RequestValues::new().query("q", "!'()*~-_.")), "q=!'()*~-_.");
    assert_eq!(serialize_query(&specs, &RequestValues::new().query("q", "😀")), "q=%F0%9F%98%80");
}

#[test]
fn skips_null_values() {
    let specs = ["a", "b", "c"].map(|n| spec(n, ParamLocation::Query, ParamStyle::Form, true));
    let values =
        RequestValues::new().query("a", &None::<i32>).query("b", &None::<Vec<String>>).query("c", &vec![Some("x"), None]);
    assert_eq!(serialize_query(&specs, &values), "c=x");
}

#[test]
fn serializes_numbers_and_booleans_as_literals() {
    let specs = ["n", "f", "b", "l"].map(|n| spec(n, ParamLocation::Query, ParamStyle::Form, true));
    let values = RequestValues::new().query("n", &42).query("f", &1.5).query("b", &true).query("l", &i64::MAX);
    assert_eq!(serialize_query(&specs, &values), "n=42&f=1.5&b=true&l=9223372036854775807");
}

#[test]
fn formats_doubles_like_javascript() {
    let cases = [
        (2.0, "2"),
        (1e10, "10000000000"),
        (1.5, "1.5"),
        (-2.5, "-2.5"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (0.000001, "0.000001"),
        (0.1 + 0.2, "0.30000000000000004"),
        (5e-324, "5e-324"),
        (f64::MAX, "1.7976931348623157e+308"),
        (-0.0, "0"),
        (0.0, "0"),
    ];
    let query = [spec("n", ParamLocation::Query, ParamStyle::Form, true)];
    let header = spec("n", ParamLocation::Header, ParamStyle::Simple, false);
    for (value, expected) in cases {
        assert_eq!(
            serialize_query(&query, &RequestValues::new().query("n", &value)),
            format!("n={}", expected.replace('+', "%2B"))
        );
        assert_eq!(serialize_header(&header, &json!(value)).unwrap().as_deref(), Some(expected), "{value}");
    }
}

#[test]
fn serialize_cookie_joins_with_semicolon_space() {
    let specs = [
        spec("theme", ParamLocation::Cookie, ParamStyle::Form, true),
        spec("tags", ParamLocation::Cookie, ParamStyle::Form, false),
    ];
    let values = RequestValues::new().cookie("theme", "dark").cookie("tags", &["x", "y"]);
    assert_eq!(serialize_cookie(&specs, &values).as_deref(), Some("theme=dark; tags=x,y"));
    assert_eq!(serialize_cookie(&specs, &RequestValues::new()), None);
}

#[test]
fn serializes_header_without_encoding() {
    let header = spec("X-Ids", ParamLocation::Header, ParamStyle::Simple, false);
    assert_eq!(serialize_header(&header, &json!(["a b", "c/d"])).unwrap().as_deref(), Some("a b,c/d"));
    let mut map = BTreeMap::new();
    map.insert("k", "v");
    let exploded = ParamSpec { explode: true, ..header };
    assert_eq!(serialize_header(&exploded, &json!(map)).unwrap().as_deref(), Some("k=v"));
}

#[test]
fn rejects_dot_segment_and_missing_path_values() {
    let specs = [spec("id", ParamLocation::Path, ParamStyle::Simple, false)];
    for value in [".", "..", ""] {
        assert!(serialize_path("/a/{id}", &specs, &RequestValues::new().path("id", value)).is_err(), "{value:?}");
    }
    assert!(serialize_path("/a/{id}", &specs, &RequestValues::new()).is_err());
}

#[test]
fn rejects_cr_lf_in_header() {
    let header = spec("X-A", ParamLocation::Header, ParamStyle::Simple, false);
    assert!(serialize_header(&header, &json!(["a\r\nb"])).is_err());
}

#[test]
fn form_encoding_matches_url_search_params() {
    let bytes = FormBody::new().add("a b&c", "*-._~!'").add("日", "x").to_bytes();
    assert_eq!(String::from_utf8(bytes).unwrap(), "a+b%26c=*-._%7E%21%27&%E6%97%A5=x");
}

#[test]
fn deep_object_keeps_declaration_order() {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Filter {
        status: &'static str,
        min_age: i32,
    }
    let specs = [spec("filter", ParamLocation::Query, ParamStyle::DeepObject, true)];
    let values = RequestValues::new().query("filter", &Filter { status: "active", min_age: 3 });
    assert_eq!(serialize_query(&specs, &values), "filter[status]=active&filter[minAge]=3");
}

#[test]
fn leaves_unknown_placeholders_and_braces_alone() {
    let specs = [spec("id", ParamLocation::Path, ParamStyle::Simple, false)];
    let values = RequestValues::new().path("id", &7);
    assert_eq!(serialize_path("/a/{id}/{other}/{}", &specs, &values).unwrap(), "/a/7/{other}/{}");
}
