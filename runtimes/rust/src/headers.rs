use std::fmt;

/// Header names whose values `Debug` output masks.
const SENSITIVE: [&str; 4] = ["authorization", "cookie", "proxy-authorization", "set-cookie"];

/// Case-insensitive HTTP headers with one value per name, kept in insertion order.
/// Setting an existing name replaces its value in place.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ApiHeaders {
    entries: Vec<(String, String)>,
}

impl ApiHeaders {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The value of `name` (compared case-insensitively).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.index_of(name).map(|i| self.entries[i].1.as_str())
    }

    /// Sets `name`, replacing the value of an existing header with the same name (keeping its position).
    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        let value = value.into();
        match self.index_of(&name) {
            Some(i) => self.entries[i].1 = value,
            None => self.entries.push((name, value)),
        }
    }

    /// Removes `name`; returns whether it was present.
    pub fn remove(&mut self, name: &str) -> bool {
        match self.index_of(name) {
            Some(i) => {
                self.entries.remove(i);
                true
            }
            None => false,
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.index_of(name).is_some()
    }

    /// The headers as `(name, value)` in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(n, v)| (n.as_str(), v.as_str()))
    }

    fn index_of(&self, name: &str) -> Option<usize> {
        self.entries.iter().position(|(n, _)| n.eq_ignore_ascii_case(name))
    }
}

impl<K: Into<String>, V: Into<String>> FromIterator<(K, V)> for ApiHeaders {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut headers = ApiHeaders::new();
        for (name, value) in iter {
            headers.set(name, value);
        }
        headers
    }
}

impl fmt::Debug for ApiHeaders {
    /// Credentials (`Authorization`, `Cookie`, ...) are shown as `***`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map()
            .entries(self.entries.iter().map(|(n, v)| {
                let sensitive = SENSITIVE.iter().any(|s| n.eq_ignore_ascii_case(s));
                (n.as_str(), if sensitive { "***" } else { v.as_str() })
            }))
            .finish()
    }
}
