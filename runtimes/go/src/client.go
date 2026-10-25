package core

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Client builds, sends and decodes operation calls for a generated client.
type Client struct {
	options     Options
	schemes     map[string]SecuritySchemeSpec
	http        *http.Client
	auth        *authState
	credentials credentialNames
	redactHead  []string
	redactQuery []string

	mu         sync.Mutex
	middleware []Middleware
}

// NewClient returns a client for the security schemes of the API.
func NewClient(options Options, schemes map[string]SecuritySchemeSpec) *Client {
	c := &Client{options: options, schemes: schemes}
	c.middleware = append([]Middleware(nil), options.Middleware...)

	// A shallow copy that never follows redirects: the transport follows them itself.
	httpClient := http.Client{}
	if options.HTTPClient != nil {
		httpClient = *options.HTTPClient
	}
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c.http = &httpClient

	names := make([]string, 0, len(schemes))
	for name := range schemes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scheme := schemes[name]
		if scheme.Kind != SchemeAPIKey {
			continue
		}
		switch scheme.In {
		case APIKeyInHeader:
			c.credentials.headers = append(c.credentials.headers, scheme.Name)
			c.redactHead = append(c.redactHead, scheme.Name)
		case APIKeyInQuery:
			c.credentials.query = append(c.credentials.query, scheme.Name)
			c.redactQuery = append(c.redactQuery, scheme.Name)
		}
	}
	c.auth = &authState{client: c}
	return c
}

// Options returns the options the client was created with.
func (c *Client) Options() Options { return c.options }

// Use appends a middleware (inside those already registered, outside authentication).
func (c *Client) Use(middleware Middleware) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.middleware = append(c.middleware, middleware)
}

// Do sends one operation call and decodes a 2xx body with decode. A non-2xx response returns an *APIError
// (with the response); the response is nil only when none was received.
func Do[T any](ctx context.Context, c *Client, op *OperationSpec, values *Values, decode Decoder[T], errs ErrorDecoders, opts []RequestOption) (T, *http.Response, error) {
	var zero T
	if ctx == nil {
		ctx = context.Background()
	}
	if values == nil {
		values = NewValues()
	}
	var requestOptions RequestOptions
	for _, opt := range opts {
		opt(&requestOptions)
	}
	req, err := c.buildRequest(op, values, &requestOptions)
	if err != nil {
		return zero, nil, err
	}
	cc := &CallContext{
		Context:       ctx,
		OperationName: op.Name,
		Method:        op.Method,
		PathTemplate:  op.Path,
		Tags:          op.Tags,
		Security:      op.Security,
		Attempt:       1,
		RedactHeaders: c.redactHead,
		RedactQuery:   c.redactQuery,
		Extensions:    map[string]any{},
	}
	for key, value := range requestOptions.Extensions {
		cc.Extensions[key] = value
	}

	c.mu.Lock()
	chain := append(append([]Middleware(nil), c.middleware...), c.auth.intercept)
	c.mu.Unlock()
	terminal := func(req *Request) (*Response, error) {
		return send(ctx, c.http, req, c.options.Timeout, c.credentials)
	}

	resp, err := compose(chain, terminal, cc)(req)
	if err != nil {
		if resp != nil {
			return zero, resp.HTTP(), err
		}
		return zero, nil, err
	}
	if resp == nil {
		return zero, nil, errors.New("the middleware chain returned no response")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return zero, resp.HTTP(), errs.newAPIError(resp)
	}
	data, err := decode(resp.StatusCode, resp.Body)
	return data, resp.HTTP(), err
}

func (c *Client) buildRequest(op *OperationSpec, values *Values, o *RequestOptions) (*Request, error) {
	if values.err != nil {
		return nil, values.err
	}
	path, err := serializePath(op.Path, op.Params, values)
	if err != nil {
		return nil, err
	}
	baseURL := c.options.BaseURL
	if o.BaseURL != "" {
		baseURL = o.BaseURL
	}
	basePath, baseQuery, _ := strings.Cut(baseURL, "?")
	var queries []string
	for _, q := range []string{baseQuery, serializeQuery(op.Params, values)} {
		if q != "" {
			queries = append(queries, q)
		}
	}
	url := strings.TrimRight(basePath, "/") + "/" + strings.TrimLeft(path, "/")
	if len(queries) > 0 {
		url += "?" + strings.Join(queries, "&")
	}
	if err := requireAbsolute(url); err != nil {
		return nil, err
	}

	header := http.Header{}
	for name, value := range c.options.Headers {
		header.Set(name, value)
	}
	for _, spec := range op.Params {
		if spec.In != InHeader {
			continue
		}
		value, ok := values.get(InHeader, spec.Name)
		if !ok {
			continue
		}
		text, ok, err := serializeHeader(spec, value)
		if err != nil {
			return nil, err
		}
		if ok {
			header.Set(spec.Name, text)
		}
	}
	for name, list := range o.Header {
		header[http.CanonicalHeaderKey(name)] = append([]string(nil), list...)
	}
	if cookie := serializeCookie(op.Params, values); cookie != "" {
		if existing := header.Get("Cookie"); existing != "" {
			cookie = existing + "; " + cookie
		}
		header.Set("Cookie", cookie)
	}

	var body Body
	if op.Body != BodyNone && values.body != nil {
		body = values.body(op.MediaType)
		if contentType := body.ContentType(); contentType == "" {
			header.Del("Content-Type")
		} else if o.Header.Get("Content-Type") == "" {
			header.Set("Content-Type", contentType)
		}
	}
	if header.Get("Accept") == "" {
		accept := "*/*"
		for _, kind := range op.Responses {
			if kind == ResponseJSON {
				accept = "application/json"
				break
			}
		}
		header.Set("Accept", accept)
	}
	return &Request{Method: op.Method, URL: url, Header: header, Body: body}, nil
}
