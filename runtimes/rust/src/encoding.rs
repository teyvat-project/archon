//! Percent-encoding that matches JavaScript's `encodeURIComponent` and `URLSearchParams` byte for byte.

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is encoded.
pub(crate) fn component(s: &str) -> String {
    encode(s, false, is_component_safe)
}

/// [`component`], keeping the RFC 3986 reserved characters `:/?#[]@$&+,;=` (query `allowReserved`).
pub(crate) fn reserved(s: &str) -> String {
    encode(s, false, |c| is_component_safe(c) || b":/?#[]@$&+,;=".contains(&c))
}

/// `application/x-www-form-urlencoded` as `URLSearchParams` writes it: alphanumerics and `*-._` stay, space is `+`.
pub(crate) fn form(s: &str) -> String {
    encode(s, true, |c| c.is_ascii_alphanumeric() || b"*-._".contains(&c))
}

fn is_component_safe(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&c)
}

fn encode(s: &str, space_as_plus: bool, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b < 0x80 && keep(b) {
            out.push(b as char);
        } else if b == b' ' && space_as_plus {
            out.push('+');
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xF) as usize] as char);
        }
    }
    out
}

/// Decodes `%XX` sequences (and `+` as a space when `plus_as_space`); `None` when a sequence is malformed or the
/// result is not UTF-8.
pub(crate) fn decode(s: &str, plus_as_space: bool) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let high = (hex[0] as char).to_digit(16)?;
                let low = (hex[1] as char).to_digit(16)?;
                out.push((high * 16 + low) as u8);
                i += 3;
            }
            b'+' if plus_as_space => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}
