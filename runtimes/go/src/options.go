package core

import (
	"net/http"
	"time"
)

// AuthConfig returns the credentials configured for a security scheme (a TokenProvider, a BasicProvider or an
// *OAuth2), or nil. The generated Auth type implements it.
type AuthConfig interface {
	Get(scheme string) any
}

// Options configures a client. They are copied when the client is created; use Client.Use to add middleware
// later.
type Options struct {
	// BaseURL is the absolute base URL; its path is kept (https://x.test/api/ + /foo → https://x.test/api/foo).
	BaseURL string
	// Headers are sent with every request.
	Headers map[string]string
	// Timeout is the time allowed until the final response headers arrive (redirects included; reading the body
	// is not timed). Zero waits indefinitely (the caller's context still applies).
	Timeout time.Duration
	// Middleware, outermost first.
	Middleware []Middleware
	// HTTPClient sends the requests (and OAuth2 token requests); nil uses a client with http.DefaultTransport.
	// The runtime sends through a shallow copy whose CheckRedirect stops at the first response, so it follows
	// redirects itself (dropping credentials when the origin changes). The client itself is not modified.
	HTTPClient *http.Client
	// CustomAuth is called last when applying authentication; it also satisfies schemes the generator could not
	// model.
	CustomAuth func(req *Request, ctx *CallContext) error
	// Auth holds the credentials per security scheme (the generated *Auth).
	Auth AuthConfig
}

// RequestOptions are per-call settings, set through RequestOption functions.
type RequestOptions struct {
	// Header are extra headers for this call (they override client headers with the same name).
	Header http.Header
	// Extensions are handed to middleware through CallContext.Extensions.
	Extensions map[string]any
	// BaseURL overrides the client's base URL for this call.
	BaseURL string
}

// RequestOption changes the settings of one call.
type RequestOption func(*RequestOptions)

// WithHeader sets a header for this call.
func WithHeader(name, value string) RequestOption {
	return func(o *RequestOptions) {
		if o.Header == nil {
			o.Header = http.Header{}
		}
		o.Header.Set(name, value)
	}
}

// WithBaseURL overrides the base URL for this call.
func WithBaseURL(baseURL string) RequestOption {
	return func(o *RequestOptions) { o.BaseURL = baseURL }
}

// WithExtension hands a value to middleware through CallContext.Extensions.
func WithExtension(key string, value any) RequestOption {
	return func(o *RequestOptions) {
		if o.Extensions == nil {
			o.Extensions = map[string]any{}
		}
		o.Extensions[key] = value
	}
}
