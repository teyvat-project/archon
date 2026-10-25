package core

import (
	"strings"
	"unicode/utf8"
)

const upperHex = "0123456789ABCDEF"

// encodeComponent is JavaScript's encodeURIComponent: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is encoded.
func encodeComponent(s string) string {
	return percentEncode(s, false, isComponentSafe)
}

// encodeReserved is encodeComponent keeping the RFC 3986 reserved characters `:/?#[]@$&+,;=` (query
// allowReserved).
func encodeReserved(s string) string {
	return percentEncode(s, false, func(c byte) bool { return isComponentSafe(c) || strings.IndexByte(":/?#[]@$&+,;=", c) >= 0 })
}

// encodeForm is application/x-www-form-urlencoded as URLSearchParams writes it: alphanumerics and `*-._` stay,
// space is `+`.
func encodeForm(s string) string {
	return percentEncode(s, true, func(c byte) bool { return isAlphaNumeric(c) || strings.IndexByte("*-._", c) >= 0 })
}

func isAlphaNumeric(c byte) bool {
	return 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9'
}

func isComponentSafe(c byte) bool {
	return isAlphaNumeric(c) || strings.IndexByte("-_.!~*'()", c) >= 0
}

// percentEncode encodes s as UTF-8; invalid UTF-8 becomes U+FFFD, as TextEncoder would.
func percentEncode(s string, spaceAsPlus bool, keep func(byte) bool) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case keep(c):
				b.WriteByte(c)
			case c == ' ' && spaceAsPlus:
				b.WriteByte('+')
			default:
				writeEscaped(&b, []byte{c})
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size <= 1 {
			writeEscaped(&b, []byte(string(utf8.RuneError)))
			i++
			continue
		}
		writeEscaped(&b, []byte(s[i:i+size]))
		i += size
	}
	return b.String()
}

func writeEscaped(b *strings.Builder, bytes []byte) {
	for _, c := range bytes {
		b.WriteByte('%')
		b.WriteByte(upperHex[c>>4])
		b.WriteByte(upperHex[c&0xF])
	}
}
