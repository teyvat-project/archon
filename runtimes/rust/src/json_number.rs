//! Renders numbers the way JavaScript's `Number.prototype.toString` does, so every runtime emits the same bytes.

use serde_json::Number;

/// A JSON number as JavaScript would print it; integers are kept as written.
pub(crate) fn format_number(n: &Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    match n.as_f64() {
        Some(v) => format_f64(v),
        None => n.to_string(),
    }
}

/// `String(value)` in JavaScript: shortest round-trip digits, no `.0`, exponent form outside `1e-7 < |x| < 1e21`.
pub(crate) fn format_f64(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }

    // `{:e}` prints the shortest digits that round-trip, as `d.ddde<exp>`.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i32;
    // value = 0.<digits> * 10^n
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;

    let sign = if value < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let mantissa = if k == 1 { digits.to_owned() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{mantissa}e{}{}", if e < 0 { '-' } else { '+' }, e.abs())
    };
    format!("{sign}{body}")
}
