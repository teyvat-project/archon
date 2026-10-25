//! The sources are vendored into generated SDKs: they must not carry tests, unsafe code, macros or extra crates.

use std::fs;
use std::path::Path;

#[test]
fn runtime_sources_carry_no_test_code_unsafe_or_macros() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let forbidden = ["#[cfg(test)]", "unsafe ", "extern crate", "macro_rules!", "#[macro_export]"];
    let mut problems = Vec::new();
    for entry in fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let source = fs::read_to_string(&path).unwrap();
        for (i, line) in source.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for word in forbidden.iter().filter(|w| line.contains(**w)) {
                problems.push(format!("{}:{}: {word}", path.display(), i + 1));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn runtime_depends_only_on_reqwest_serde_serde_json_and_tokio() {
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let dependencies: Vec<&str> = manifest
        .split("[dependencies]")
        .nth(1)
        .unwrap()
        .split("\n[")
        .next()
        .unwrap()
        .lines()
        .filter_map(|l| l.split_once('=').map(|(name, _)| name.trim()))
        .collect();
    assert_eq!(dependencies, ["reqwest", "serde", "serde_json", "tokio"]);
}
