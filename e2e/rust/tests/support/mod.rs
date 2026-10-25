//! The mock server's address and counters, and client helpers.
#![allow(dead_code)]

use std::collections::HashMap;

use archon_edge_cases::{ApiClient, ApiClientBuilder};

pub fn base_url() -> String {
    env("ARCHON_E2E_BASE_URL")
}

pub fn secondary_url() -> String {
    env("ARCHON_E2E_SECONDARY_URL")
}

fn env(name: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| panic!("{name} is not set; run the suite with `pnpm test:e2e:rust`."))
}

/// A builder pointed at the mock server.
pub fn builder() -> ApiClientBuilder {
    ApiClient::builder().base_url(base_url())
}

pub fn client() -> ApiClient {
    builder().build()
}

/// The mock server's counters: tokens issued and requests per raw path.
#[derive(Debug, Clone)]
pub struct Stats {
    pub tokens_issued: u64,
    pub requests: HashMap<String, u64>,
}

impl Stats {
    pub fn count(&self, path: &str) -> u64 {
        self.requests.get(path).copied().unwrap_or(0)
    }
}

pub async fn stats() -> Stats {
    let http = archon_edge_cases::core::http_client_builder().build().unwrap();
    let text = http.get(format!("{}/__stats", base_url())).send().await.unwrap().text().await.unwrap();
    let root: serde_json::Value = serde_json::from_str(&text).unwrap();
    let requests = root["requests"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_u64().unwrap())).collect();
    Stats { tokens_issued: root["tokensIssued"].as_u64().unwrap(), requests }
}

pub async fn request_count(path: &str) -> u64 {
    stats().await.count(path)
}

/// `scheme://host:port` of a URL.
pub fn origin(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap();
    format!("{scheme}://{}", rest.split('/').next().unwrap())
}

pub fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}
