//! String-level URL handling, so paths and queries keep their exact bytes until reqwest parses them for sending.

use crate::encoding;

/// An RFC 3986 reference split into its components; `None` means the component is absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Parts {
    pub scheme: Option<String>,
    pub authority: Option<String>,
    pub path: String,
    pub query: Option<String>,
    pub fragment: Option<String>,
}

impl Parts {
    pub fn render(&self) -> String {
        let mut out = String::new();
        if let Some(scheme) = &self.scheme {
            out.push_str(scheme);
            out.push(':');
        }
        if let Some(authority) = &self.authority {
            out.push_str("//");
            out.push_str(authority);
        }
        out.push_str(&self.path);
        if let Some(query) = &self.query {
            out.push('?');
            out.push_str(query);
        }
        if let Some(fragment) = &self.fragment {
            out.push('#');
            out.push_str(fragment);
        }
        out
    }
}

/// Splits per RFC 3986 appendix B.
pub(crate) fn split(url: &str) -> Parts {
    let mut rest = url;
    let mut fragment = None;
    if let Some(i) = rest.find('#') {
        fragment = Some(rest[i + 1..].to_owned());
        rest = &rest[..i];
    }
    let mut query = None;
    if let Some(i) = rest.find('?') {
        query = Some(rest[i + 1..].to_owned());
        rest = &rest[..i];
    }
    let mut scheme = None;
    if let Some(i) = rest.find(':') {
        if i > 0 && !rest[..i].contains('/') {
            scheme = Some(rest[..i].to_owned());
            rest = &rest[i + 1..];
        }
    }
    let mut authority = None;
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find('/').unwrap_or(after.len());
        authority = Some(after[..end].to_owned());
        rest = &after[end..];
    }
    Parts { scheme, authority, path: rest.to_owned(), query, fragment }
}

/// Whether `url` is an absolute http(s) URL with a host.
pub(crate) fn is_absolute_http(url: &str) -> bool {
    let parts = split(url);
    let scheme = parts.scheme.map(|s| s.to_ascii_lowercase());
    matches!(scheme.as_deref(), Some("http") | Some("https")) && parts.authority.is_some_and(|a| !a.is_empty())
}

/// Resolves a (possibly relative) reference against `base` (WHATWG URL rules, as browsers follow `Location`).
pub(crate) fn resolve(base: &str, reference: &str) -> Option<String> {
    reqwest::Url::parse(base).ok()?.join(reference).ok().map(|u| u.to_string())
}

/// Whether two URLs have the same origin (scheme, host and port, default ports made explicit).
pub(crate) fn same_origin(a: &str, b: &str) -> bool {
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// The `name=value` pairs of a query string.
pub(crate) fn query_pairs(query: Option<&str>) -> Vec<&str> {
    query.unwrap_or("").split('&').filter(|p| !p.is_empty()).collect()
}

/// The decoded name of a `name=value` pair (`+` is a space); an undecodable name is returned as written.
pub(crate) fn decode_name(pair: &str) -> String {
    let raw = pair.split('=').next().unwrap_or("");
    encoding::decode(raw, true).unwrap_or_else(|| raw.replace('+', " "))
}

/// Removes every query parameter whose decoded name is one of `names` (case-sensitive).
pub(crate) fn without_query_parameters(url: &str, names: &[String]) -> String {
    if names.is_empty() {
        return url.to_owned();
    }
    let mut parts = split(url);
    let Some(query) = parts.query.take() else { return url.to_owned() };
    let kept: Vec<&str> = query_pairs(Some(&query)).into_iter().filter(|p| !names.contains(&decode_name(p))).collect();
    parts.query = if kept.is_empty() { None } else { Some(kept.join("&")) };
    parts.render()
}

/// Sets a query parameter, replacing any with the same name and leaving the other parameters' bytes untouched.
pub(crate) fn set_query_parameter(url: &str, name: &str, value: &str) -> String {
    let mut parts = split(url);
    let query = parts.query.take();
    let mut pairs: Vec<String> =
        query_pairs(query.as_deref()).into_iter().filter(|p| decode_name(p) != name).map(str::to_owned).collect();
    pairs.push(format!("{}={}", encoding::component(name), encoding::component(value)));
    parts.query = Some(pairs.join("&"));
    parts.fragment = None;
    parts.render()
}
