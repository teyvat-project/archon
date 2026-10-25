package core

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// LoggingOptions configures Logging.
type LoggingOptions struct {
	// Log receives each line (default log.Print).
	Log func(line string)
	// IncludeHeaders also logs the request headers, one line each (by name).
	IncludeHeaders bool
	// RedactHeaders and RedactQuery are masked in addition to the defaults (case-insensitive).
	RedactHeaders []string
	RedactQuery   []string
	// Now is the clock (default time.Now).
	Now func() time.Time
}

const mask = "***"

var defaultRedactHeaders = []string{"Authorization", "Cookie", "Proxy-Authorization", "Set-Cookie"}

// Logging logs `→ METHOD url` (optionally with headers) and `← status (ms)`. Credentials are masked as ***:
// Authorization, Cookie, Proxy-Authorization, Set-Cookie, the API key headers and query parameters of the spec,
// and the names in RedactHeaders / RedactQuery.
func Logging(o LoggingOptions) Middleware {
	logLine := o.Log
	if logLine == nil {
		logLine = func(line string) { log.Print(line) }
	}
	now := o.Now
	if now == nil {
		now = time.Now
	}
	return func(req *Request, next Next, ctx *CallContext) (*Response, error) {
		headers := append(append(append([]string(nil), defaultRedactHeaders...), ctx.RedactHeaders...), o.RedactHeaders...)
		query := append(append([]string(nil), ctx.RedactQuery...), o.RedactQuery...)

		logLine("→ " + req.Method + " " + maskedURL(req.URL, query))
		if o.IncludeHeaders {
			names := make([]string, 0, len(req.Header))
			for name := range req.Header {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				for _, value := range req.Header[name] {
					if containsFold(headers, name) {
						value = mask
					}
					logLine("  " + name + ": " + value)
				}
			}
		}
		started := now()
		resp, err := next(req)
		if err != nil {
			return resp, err
		}
		logLine(fmt.Sprintf("← %d (%dms)", resp.StatusCode, now().Sub(started).Milliseconds()))
		return resp, nil
	}
}

// maskedURL is the URL for display, without its fragment and with the values of the given query names masked.
func maskedURL(raw string, redactQuery []string) string {
	parts := splitURL(raw)
	parts.fragment = nil
	if parts.query == nil {
		return parts.String()
	}
	pairs := strings.Split(*parts.query, "&")
	for i, pair := range pairs {
		if eq := strings.IndexByte(pair, '='); eq >= 0 && containsFold(redactQuery, decodeName(pair)) {
			pairs[i] = pair[:eq] + "=" + mask
		}
	}
	return parts.withQuery(strings.Join(pairs, "&")).String()
}

// UserAgent sets the User-Agent header.
func UserAgent(value string) Middleware {
	return func(req *Request, next Next, _ *CallContext) (*Response, error) {
		req.Header.Set("User-Agent", value)
		return next(req)
	}
}

// RetryOptions configures Retry; zero values use the defaults.
type RetryOptions struct {
	// MaxAttempts counts the first send (default 3).
	MaxAttempts int
	// BaseDelay and MaxDelay bound the exponential backoff (default 200ms and 5s).
	BaseDelay time.Duration
	MaxDelay  time.Duration
	// MaxRetryAfter caps a server-supplied Retry-After (default 60s).
	MaxRetryAfter time.Duration
	// Statuses are retried (default 408, 429, 500, 502, 503, 504).
	Statuses []int
	// Methods are retried (default the idempotent GET, HEAD, OPTIONS, PUT, DELETE).
	Methods []string
	// DisableNetworkRetry stops retrying network errors (they are retried by default; timeouts never are).
	DisableNetworkRetry bool
	// Sleep waits between attempts (default: a timer that stops when ctx ends).
	Sleep func(ctx context.Context, d time.Duration) error
	// Random is the jitter source in [0, 1) (default math/rand).
	Random func() float64
	// Now is the clock for HTTP-date Retry-After values (default time.Now).
	Now func() time.Time
}

func (o RetryOptions) withDefaults() RetryOptions {
	if o.MaxAttempts == 0 {
		o.MaxAttempts = 3
	}
	if o.BaseDelay == 0 {
		o.BaseDelay = 200 * time.Millisecond
	}
	if o.MaxDelay == 0 {
		o.MaxDelay = 5 * time.Second
	}
	if o.MaxRetryAfter == 0 {
		o.MaxRetryAfter = 60 * time.Second
	}
	if o.Statuses == nil {
		o.Statuses = []int{408, 429, 500, 502, 503, 504}
	}
	if o.Methods == nil {
		o.Methods = []string{http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPut, http.MethodDelete}
	}
	if o.Sleep == nil {
		o.Sleep = sleep
	}
	if o.Random == nil {
		o.Random = rand.Float64
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// backoff is equal jitter: min(MaxDelay, BaseDelay * 2^(attempt-1)) * (0.5 + random/2).
func (o RetryOptions) backoff(attempt int) time.Duration {
	exponential := math.Min(float64(o.MaxDelay), float64(o.BaseDelay)*math.Pow(2, float64(attempt-1)))
	return time.Duration(exponential * (0.5 + o.Random()/2))
}

// Retry retries idempotent, replayable requests on the configured statuses and on network errors (not on
// timeouts or cancellation), with exponential backoff and equal jitter. Retry-After on 429 / 503 is honoured,
// capped by MaxRetryAfter.
func Retry(options RetryOptions) Middleware {
	o := options.withDefaults()
	return func(req *Request, next Next, ctx *CallContext) (*Response, error) {
		retryable := req.Replayable() && contains(o.Methods, req.Method)
		for attempt := 1; ; attempt++ {
			canRetry := retryable && attempt < o.MaxAttempts
			resp, err := next(req)
			var delay time.Duration
			if err != nil {
				var transportErr *TransportError
				if !canRetry || o.DisableNetworkRetry || !errors.As(err, &transportErr) || transportErr.Timeout || ctx.Context.Err() != nil {
					return resp, err
				}
				delay = o.backoff(attempt)
			} else {
				if !canRetry || !containsInt(o.Statuses, resp.StatusCode) {
					return resp, nil
				}
				delay = o.backoff(attempt)
				if resp.StatusCode == 429 || resp.StatusCode == 503 {
					if after, ok := parseRetryAfter(resp.Header.Get("Retry-After"), o.Now()); ok {
						delay = min(after, o.MaxRetryAfter)
					}
				}
			}
			if err := o.Sleep(ctx.Context, delay); err != nil {
				return nil, &TransportError{Err: err}
			}
			ctx.Attempt++
		}
	}
}

// parseRetryAfter reads seconds or an HTTP-date.
func parseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if strings.Trim(value, "0123456789") == "" {
		seconds, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return 0, false
		}
		return time.Duration(seconds) * time.Second, true
	}
	date, err := http.ParseTime(value)
	if err != nil {
		return 0, false
	}
	return max(date.Sub(now), 0), true
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Retry401 re-sends once after a 401 when onUnauthorized returns true (e.g. after rotating a static token).
// Managed OAuth2 tokens already refresh once on 401 inside the authentication layer, so the callback should
// return false for those schemes.
func Retry401(onUnauthorized func(ctx *CallContext, resp *Response) bool) Middleware {
	return func(req *Request, next Next, ctx *CallContext) (*Response, error) {
		resp, err := next(req)
		if err != nil || resp.StatusCode != 401 || !req.Replayable() || !onUnauthorized(ctx, resp) {
			return resp, err
		}
		ctx.Attempt++
		return next(req)
	}
}

func containsInt(list []int, value int) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
