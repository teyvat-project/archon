package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// credentialNames are the names that carry credentials and must not cross origins.
type credentialNames struct {
	headers []string
	query   []string
}

const maxRedirects = 20

var errTimedOut = errors.New("the client timeout elapsed")

var bodyHeaders = []string{"Content-Encoding", "Content-Language", "Content-Location", "Content-Type", "Content-Length"}

// send sends the request, following redirects by hand so credentials are dropped when the origin changes
// (spec §8.5). The timeout covers everything up to the final response's headers (redirects included), not reading
// the body. The caller's own cancellation wraps the context's error.
func send(ctx context.Context, client *http.Client, req *Request, timeout time.Duration, credentials credentialNames) (*Response, error) {
	hopCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	stop := func() {}
	if timeout > 0 {
		timer := time.AfterFunc(timeout, func() { cancel(errTimedOut) })
		stop = func() { timer.Stop() }
	}
	defer stop()

	fail := func(err error) error {
		if ctx.Err() != nil {
			return &TransportError{Err: ctx.Err()}
		}
		if errors.Is(context.Cause(hopCtx), errTimedOut) {
			return &TransportError{Err: fmt.Errorf("no response within %v: %w", timeout, err), Timeout: true}
		}
		return &TransportError{Err: err}
	}

	method := req.Method
	url := req.URL
	header := req.Header.Clone()
	if header == nil {
		header = http.Header{}
	}
	body := req.Body
	for redirects := 0; ; redirects++ {
		resp, err := sendOnce(hopCtx, client, method, url, header, body)
		if err != nil {
			return nil, fail(err)
		}
		status := resp.StatusCode
		location := resp.Header.Get("Location")
		// 303 (except HEAD) and 301/302 on POST switch to a bodiless GET; everything else re-sends the body.
		toGet := status == http.StatusSeeOther && method != http.MethodHead || status < http.StatusSeeOther && method == http.MethodPost
		isRedirect := status == 301 || status == 302 || status == 303 || status == 307 || status == 308
		if !isRedirect || location == "" || !toGet && body != nil && !body.Replayable() {
			stop()
			content, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil {
				return nil, fail(err)
			}
			return &Response{StatusCode: status, Header: resp.Header, URL: url, Body: content}, nil
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if redirects >= maxRedirects {
			return nil, &TransportError{Err: fmt.Errorf("too many redirects (more than %d)", maxRedirects)}
		}

		next := resolveURL(url, location)
		if origin(next) != origin(url) {
			for _, name := range append([]string{"Authorization", "Cookie"}, credentials.headers...) {
				header.Del(name)
			}
			next = withoutQueryParameters(next, credentials.query)
		}
		if toGet {
			method = http.MethodGet
			body = nil
			for _, name := range bodyHeaders {
				header.Del(name)
			}
		}
		url = next
	}
}

func sendOnce(ctx context.Context, client *http.Client, method, raw string, header http.Header, body Body) (*http.Response, error) {
	target, err := requestURL(raw)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	length := int64(0)
	if body != nil {
		reader, length, err = body.Open()
		if err != nil {
			return nil, err
		}
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, "http://localhost/", nil)
	if err != nil {
		return nil, err
	}
	httpReq.URL = target
	httpReq.Host = ""
	httpReq.Header = header.Clone()
	httpReq.Header.Del("Content-Length")
	if reader != nil {
		httpReq.Body = http.NoBody
		if length != 0 {
			httpReq.Body = io.NopCloser(reader)
			httpReq.ContentLength = length
		}
	}
	return client.Do(httpReq)
}
