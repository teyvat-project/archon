package core

import "context"

// Next sends the request through the rest of the chain.
type Next func(req *Request) (*Response, error)

// Middleware is one layer of the onion chain. Middleware runs outer-to-inner in registration order;
// authentication is applied innermost, so calling next again re-applies fresh credentials.
type Middleware func(req *Request, next Next, ctx *CallContext) (*Response, error)

// CallContext is what the middleware chain knows about the call in flight.
type CallContext struct {
	// Context is the caller's context (cancellation, deadline, values).
	Context       context.Context
	OperationName string
	Method        string
	PathTemplate  string
	Tags          []string
	Security      []SecurityRequirement
	// Attempt is 1 for the first send; retrying middleware increments it.
	Attempt int
	// RedactHeaders are header names (case-insensitive) carrying credentials, to mask in logs.
	RedactHeaders []string
	// RedactQuery are query parameter names (case-insensitive) carrying credentials, to mask in logs.
	RedactQuery []string
	// Extensions are arbitrary per-call values (from WithExtension).
	Extensions map[string]any
}

// compose builds the chain: middleware[0] is outermost, terminal runs last.
func compose(middleware []Middleware, terminal Next, ctx *CallContext) Next {
	next := terminal
	for i := len(middleware) - 1; i >= 0; i-- {
		layer, inner := middleware[i], next
		next = func(req *Request) (*Response, error) { return layer(req, inner, ctx) }
	}
	return next
}
