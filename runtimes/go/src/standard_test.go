package core

import (
	"context"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// flakyServer answers 503 (with headers from retryAfter) `fail` times, then 200.
func flakyServer(t *testing.T, fail int32, retryAfter string) (*testServer, *atomic.Int32) {
	var calls atomic.Int32
	s := newTestServer(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if calls.Add(1) <= fail {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			reply(503, "application/json", `{}`)(w, r, nil)
			return
		}
		reply(200, "application/json", `{}`)(w, r, nil)
	})
	return s, &calls
}

func recordSleeps(delays *[]time.Duration) func(context.Context, time.Duration) error {
	return func(_ context.Context, d time.Duration) error {
		*delays = append(*delays, d)
		return nil
	}
}

func TestRetryHonoursRetryAfter(t *testing.T) {
	var delays []time.Duration
	s, calls := flakyServer(t, 1, "1")
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{Retry(RetryOptions{Sleep: recordSleeps(&delays)})}}, nil)
	var attempts int
	c.Use(func(req *Request, next Next, ctx *CallContext) (*Response, error) {
		attempts = ctx.Attempt
		return next(req)
	})
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(delays) != 1 || delays[0] != time.Second || attempts != 2 {
		t.Errorf("calls %d delays %v attempt %d", calls.Load(), delays, attempts)
	}

	delays = nil
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	s, _ = flakyServer(t, 1, now.Add(5*time.Second).Format(http.TimeFormat))
	c = NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{Retry(RetryOptions{Sleep: recordSleeps(&delays), Now: func() time.Time { return now }})}}, nil)
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(delays) != 1 || delays[0] != 5*time.Second {
		t.Errorf("HTTP-date: %v", delays)
	}

	delays = nil
	s, _ = flakyServer(t, 1, "3600")
	c = NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{Retry(RetryOptions{Sleep: recordSleeps(&delays), MaxRetryAfter: 2 * time.Second})}}, nil)
	_, _, _ = Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil)
	if len(delays) != 1 || delays[0] != 2*time.Second {
		t.Errorf("capped: %v", delays)
	}
}

func TestRetryOnlyRetriesWhatItMay(t *testing.T) {
	var delays []time.Duration
	retry := Retry(RetryOptions{Sleep: recordSleeps(&delays)})

	s, calls := flakyServer(t, 5, "0")
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{retry}}, nil)
	post := &OperationSpec{Name: "post", Method: http.MethodPost, Path: "/x"}
	if _, _, err := Do(context.Background(), c, post, nil, DecodeNone, nil, nil); err == nil || calls.Load() != 1 {
		t.Errorf("POST: calls %d", calls.Load())
	}

	calls.Store(0)
	put := &OperationSpec{Name: "put", Method: http.MethodPut, Path: "/x", Body: BodyBinary}
	_, _, _ = Do(context.Background(), c, put, NewValues().Body(NewReaderBody(strings.NewReader("x"), "")), DecodeNone, nil, nil)
	if calls.Load() != 1 {
		t.Errorf("non-replayable: calls %d", calls.Load())
	}

	calls.Store(0)
	var apiErr *APIError
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); !errors.As(err, &apiErr) || apiErr.StatusCode != 503 || calls.Load() != 3 {
		t.Errorf("max attempts: calls %d, %v", calls.Load(), err)
	}
}

func TestRetryRetriesNetworkErrorsButNotTimeouts(t *testing.T) {
	var delays []time.Duration
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := listener.Addr().String()
	_ = listener.Close()
	var sends int
	count := func(req *Request, next Next, _ *CallContext) (*Response, error) {
		sends++
		return next(req)
	}
	c := NewClient(Options{BaseURL: "http://" + addr, Middleware: []Middleware{Retry(RetryOptions{Sleep: recordSleeps(&delays)}), count}}, nil)
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err == nil || sends != 3 {
		t.Errorf("network errors: %d sends", sends)
	}

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	slow := newTestServer(t, func(_ http.ResponseWriter, r *http.Request, _ []byte) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	sends = 0
	c = NewClient(Options{BaseURL: slow.URL, Timeout: 30 * time.Millisecond, Middleware: []Middleware{Retry(RetryOptions{Sleep: recordSleeps(&delays)}), count}}, nil)
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err == nil || sends != 1 {
		t.Errorf("timeouts: %d sends", sends)
	}
}

func TestRetryUsesEqualJitter(t *testing.T) {
	low := RetryOptions{Random: func() float64 { return 0 }}.withDefaults()
	high := RetryOptions{Random: func() float64 { return 0.999999 }}.withDefaults()
	for attempt, base := range map[int]time.Duration{1: 200 * time.Millisecond, 2: 400 * time.Millisecond, 10: 5 * time.Second} {
		if got := low.backoff(attempt); got != base/2 {
			t.Errorf("attempt %d low: %v", attempt, got)
		}
		if got := high.backoff(attempt); got < base*99/100 || got > base {
			t.Errorf("attempt %d high: %v", attempt, got)
		}
	}
}

func TestRetry401SendsOnceMoreWithFreshCredentials(t *testing.T) {
	s := newTestServer(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if r.Header.Get("Authorization") != "Bearer good" {
			reply(401, "application/json", `{}`)(w, r, nil)
			return
		}
		reply(200, "application/json", `{}`)(w, r, nil)
	})
	token := "stale"
	var attempts []int
	retry := Retry401(func(ctx *CallContext, _ *Response) bool {
		attempts = append(attempts, ctx.Attempt)
		token = "good"
		return true
	})
	provider := TokenFunc(func(context.Context) (string, error) { return token, nil })
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{retry}, Auth: testAuth{"bearer": provider}}, testSchemes)
	if _, _, err := Do(context.Background(), c, authOp("bearer"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0] != 1 || len(s.received()) != 2 {
		t.Errorf("attempts %v, %d requests", attempts, len(s.received()))
	}
}

func TestLoggingMasksCredentials(t *testing.T) {
	s := newTestServer(t, nil)
	var lines []string
	logging := Logging(LoggingOptions{Log: func(line string) { lines = append(lines, line) }, IncludeHeaders: true, RedactHeaders: []string{"x-secret"}})
	withKey := func(req *Request, next Next, _ *CallContext) (*Response, error) {
		req.SetQueryParameter("api_key", "k")
		return next(req)
	}
	c := NewClient(Options{
		BaseURL:    s.URL,
		Headers:    map[string]string{"Authorization": "Bearer t", "Cookie": "c=1", "X-API-Key": "k", "X-Secret": "s", "X-Plain": "visible"},
		Middleware: []Middleware{withKey, logging},
	}, testSchemes)
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(lines, "\n")
	if lines[0] != "→ GET "+s.URL+"/x?api_key=***" {
		t.Errorf("first line %q", lines[0])
	}
	for _, want := range []string{"  Authorization: ***", "  Cookie: ***", "  X-Api-Key: ***", "  X-Secret: ***", "  X-Plain: visible"} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %q in\n%s", want, all)
		}
	}
	if !regexp.MustCompile(`^← 200 \(\d+ms\)$`).MatchString(lines[len(lines)-1]) {
		t.Errorf("last line %q", lines[len(lines)-1])
	}
}

func TestUserAgent(t *testing.T) {
	s := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{UserAgent("archon-test/1")}}, nil)
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t).Header.Get("User-Agent"); got != "archon-test/1" {
		t.Errorf("got %q", got)
	}
}
