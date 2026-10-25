package core

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Request is one HTTP request travelling through the middleware chain.
type Request struct {
	Method string
	// URL is the absolute URL, sent byte for byte (it is never re-encoded).
	URL    string
	Header http.Header
	Body   Body
}

// Replayable reports whether the request can be sent again (buffered bodies can, streamed ones cannot).
func (r *Request) Replayable() bool {
	return r.Body == nil || r.Body.Replayable()
}

// SetQueryParameter sets a query parameter, replacing any with the same name and leaving the other parameters'
// bytes untouched.
func (r *Request) SetQueryParameter(name, value string) {
	parts := splitURL(r.URL)
	var pairs []string
	for _, pair := range queryPairs(parts.query) {
		if decodeName(pair) != name {
			pairs = append(pairs, pair)
		}
	}
	pairs = append(pairs, encodeComponent(name)+"="+encodeComponent(value))
	parts = parts.withQuery(strings.Join(pairs, "&"))
	parts.fragment = nil
	r.URL = parts.String()
}

// Response is a received response; Body has been read completely.
type Response struct {
	StatusCode int
	Header     http.Header
	// URL is the final request URL (after redirects).
	URL  string
	Body []byte
}

// HTTP returns the response as an *http.Response whose Body reads the received bytes (it can be read and
// closed freely) and whose Request carries the final URL.
func (r *Response) HTTP() *http.Response {
	header := r.Header
	if header == nil {
		header = http.Header{}
	}
	request := &http.Request{Header: http.Header{}}
	if u, err := url.Parse(r.URL); err == nil {
		request.URL = u
	}
	return &http.Response{
		Status:        strconv.Itoa(r.StatusCode) + " " + http.StatusText(r.StatusCode),
		StatusCode:    r.StatusCode,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        header,
		Body:          io.NopCloser(bytes.NewReader(r.Body)),
		ContentLength: int64(len(r.Body)),
		Request:       request,
	}
}

// urlParts is an RFC 3986 reference split into its components; nil means the component is absent. Paths and
// queries keep their exact bytes (no parser re-encodes or reorders them).
type urlParts struct {
	scheme, authority *string
	path              string
	query, fragment   *string
}

// RFC 3986 appendix B.
var reference = regexp.MustCompile(`^(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$`)

func splitURL(raw string) urlParts {
	m := reference.FindStringSubmatchIndex(raw)
	group := func(i int) *string {
		if m == nil || m[2*i] < 0 {
			return nil
		}
		s := raw[m[2*i]:m[2*i+1]]
		return &s
	}
	parts := urlParts{scheme: group(1), authority: group(2), query: group(4), fragment: group(5)}
	if p := group(3); p != nil {
		parts.path = *p
	}
	return parts
}

func (p urlParts) withQuery(query string) urlParts {
	if query == "" {
		p.query = nil
	} else {
		p.query = &query
	}
	return p
}

func (p urlParts) String() string {
	var b strings.Builder
	if p.scheme != nil {
		b.WriteString(*p.scheme + ":")
	}
	if p.authority != nil {
		b.WriteString("//" + *p.authority)
	}
	b.WriteString(p.path)
	if p.query != nil {
		b.WriteString("?" + *p.query)
	}
	if p.fragment != nil {
		b.WriteString("#" + *p.fragment)
	}
	return b.String()
}

// requireAbsolute fails when raw is not an absolute http(s) URL.
func requireAbsolute(raw string) error {
	parts := splitURL(raw)
	if parts.scheme != nil && parts.authority != nil && *parts.authority != "" {
		if scheme := strings.ToLower(*parts.scheme); scheme == "http" || scheme == "https" {
			return nil
		}
	}
	return fmt.Errorf("%q is not an absolute http(s) URL; pass an absolute base URL (e.g. \"https://api.example.com\")", raw)
}

// resolveURL resolves a (possibly relative) Location against base (RFC 3986 §5.2), keeping the bytes of both.
func resolveURL(base, location string) string {
	b := splitURL(base)
	r := splitURL(location)
	var target urlParts
	switch {
	case r.scheme != nil:
		target = r
		target.path = removeDotSegments(r.path)
	case r.authority != nil:
		target = r
		target.scheme = b.scheme
		target.path = removeDotSegments(r.path)
	case r.path == "":
		target = b
		if r.query != nil {
			target.query = r.query
		}
		target.fragment = r.fragment
	case strings.HasPrefix(r.path, "/"):
		target = b
		target.path, target.query, target.fragment = removeDotSegments(r.path), r.query, r.fragment
	default:
		merged := r.path
		if b.authority != nil && b.path == "" {
			merged = "/" + r.path
		} else if i := strings.LastIndexByte(b.path, '/'); i >= 0 {
			merged = b.path[:i] + "/" + r.path
		} else {
			merged = "/" + r.path
		}
		target = b
		target.path, target.query, target.fragment = removeDotSegments(merged), r.query, r.fragment
	}
	return target.String()
}

var portSuffix = regexp.MustCompile(`:[0-9]*$`)

// origin is scheme://host:port, lower-cased, with the default port made explicit.
func origin(raw string) string {
	parts := splitURL(raw)
	scheme := ""
	if parts.scheme != nil {
		scheme = strings.ToLower(*parts.scheme)
	}
	hostPort := ""
	if parts.authority != nil {
		hostPort = strings.ToLower((*parts.authority)[strings.LastIndexByte(*parts.authority, '@')+1:])
	}
	host, port := hostPort, ""
	if portSuffix.MatchString(hostPort) {
		i := strings.LastIndexByte(hostPort, ':')
		host, port = hostPort[:i], hostPort[i+1:]
	}
	if port == "" {
		port = "80"
		if scheme == "https" {
			port = "443"
		}
	}
	return scheme + "://" + host + ":" + port
}

// withoutQueryParameters removes every query parameter with one of names (compared after decoding,
// case-sensitively).
func withoutQueryParameters(raw string, names []string) string {
	parts := splitURL(raw)
	if len(names) == 0 || parts.query == nil {
		return raw
	}
	var kept []string
	for _, pair := range queryPairs(parts.query) {
		if !contains(names, decodeName(pair)) {
			kept = append(kept, pair)
		}
	}
	return parts.withQuery(strings.Join(kept, "&")).String()
}

func queryPairs(query *string) []string {
	if query == nil {
		return nil
	}
	var out []string
	for _, pair := range strings.Split(*query, "&") {
		if pair != "" {
			out = append(out, pair)
		}
	}
	return out
}

// decodeName is the decoded name of a `name=value` pair (`+` is a space); undecodable names are returned as
// written.
func decodeName(pair string) string {
	raw, _, _ := strings.Cut(pair, "=")
	raw = strings.ReplaceAll(raw, "+", " ")
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return raw
	}
	return decoded
}

func removeDotSegments(path string) string {
	if !strings.Contains(path, ".") {
		return path
	}
	input := strings.Split(path, "/")
	var output []string
	for i, segment := range input {
		last := i == len(input)-1
		switch segment {
		case ".":
			if last {
				output = append(output, "")
			}
		case "..":
			if len(output) > 1 {
				output = output[:len(output)-1]
			}
			if last {
				output = append(output, "")
			}
		default:
			output = append(output, segment)
		}
	}
	return strings.Join(output, "/")
}

// requestURL is raw as a *url.URL that net/http sends without changing a byte of the path or the query (the
// request line is Opaque + "?" + RawQuery).
func requestURL(raw string) (*url.URL, error) {
	parts := splitURL(raw)
	if parts.scheme == nil || parts.authority == nil || strings.HasPrefix(parts.path, "//") {
		return url.Parse(raw)
	}
	u := &url.URL{Scheme: strings.ToLower(*parts.scheme), Host: *parts.authority, Opaque: parts.path}
	if i := strings.LastIndexByte(u.Host, '@'); i >= 0 {
		info, err := url.Parse("http://" + u.Host[:i+1] + "x")
		if err != nil {
			return nil, err
		}
		u.User, u.Host = info.User, u.Host[i+1:]
	}
	if parts.query != nil {
		u.RawQuery = *parts.query
		u.ForceQuery = *parts.query == ""
	}
	return u, nil
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func containsFold(list []string, value string) bool {
	for _, item := range list {
		if strings.EqualFold(item, value) {
			return true
		}
	}
	return false
}
