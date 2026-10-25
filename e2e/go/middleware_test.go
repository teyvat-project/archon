package e2e

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func withMiddleware(middleware ...core.Middleware) func(*edgecases.ClientOptions) {
	return func(o *edgecases.ClientOptions) { o.Middleware = append(o.Middleware, middleware...) }
}

func uniqueKey(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func TestRetries503ResponsesUntilTheEndpointSucceeds(t *testing.T) {
	key := uniqueKey("retry")
	data, _, err := newClient(withMiddleware(core.Retry(core.RetryOptions{}))).Middleware.Flaky(ctx, edgecases.FlakyParams{Key: key, Fail: core.Ptr(2)})
	noError(t, err)
	equal(t, data.Key, key)
	equal(t, data.Attempts, 3)
}

func TestGivesUpAfterMaxAttemptsAndReturnsTheTyped503(t *testing.T) {
	client := newClient(withMiddleware(core.Retry(core.RetryOptions{MaxAttempts: 2})))
	_, _, err := client.Middleware.Flaky(ctx, edgecases.FlakyParams{Key: uniqueKey("give-up"), Fail: core.Ptr(5)})
	var apiErr *core.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("got %v", err)
	}
	equal(t, apiErr.StatusCode, 503)
	body, ok := core.ErrorBody[*edgecases.Error](err)
	equal(t, ok, true)
	equal(t, body.Code, 503)
}

func TestResendsOnceAfterA401WhenTheTokenWasSwappedByRetry401(t *testing.T) {
	token := "expired-token"
	var swaps []int
	retry := core.Retry401(func(cc *core.CallContext, _ *core.Response) bool {
		swaps = append(swaps, cc.Attempt)
		token = "test-token"
		return true
	})
	provider := core.TokenFunc(func(context.Context) (string, error) { return token, nil })
	client := newClient(withAuth(&edgecases.Auth{BearerAuth: provider}), withMiddleware(retry))
	echo, _, err := client.Auth.AuthBearer(ctx)
	noError(t, err)
	equal(t, echo.Headers["authorization"], "Bearer test-token")
	equal(t, fmt.Sprint(swaps), "[1]")
}

func TestMasksCredentialsInLogs(t *testing.T) {
	var lines []string
	// Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
	withQueryKey := func(req *core.Request, next core.Next, _ *core.CallContext) (*core.Response, error) {
		req.SetQueryParameter("api_key", "test-key")
		return next(req)
	}
	logging := core.Logging(core.LoggingOptions{Log: func(line string) { lines = append(lines, line) }, IncludeHeaders: true})
	client := newClient(func(o *edgecases.ClientOptions) {
		o.Headers = map[string]string{"Authorization": "Bearer test-token", "X-API-Key": "test-key"}
	}, withMiddleware(withQueryKey, logging))
	echo, _, err := client.Echo.EchoHeadersCookies(ctx, edgecases.EchoHeadersCookiesParams{XRequestIds: []string{"r1"}, Theme: "dark"})
	noError(t, err)
	// The server did receive the credentials...
	equal(t, echo.Headers["authorization"], "Bearer test-token")
	equal(t, echo.Headers["x-api-key"], "test-key")
	equal(t, echo.Query, "api_key=test-key")

	// ...but the log did not.
	logged := strings.Join(lines, "\n")
	for _, secret := range []string{"test-token", "test-key", "dark"} {
		if strings.Contains(logged, secret) {
			t.Errorf("%q leaked into\n%s", secret, logged)
		}
	}
	equal(t, lines[0], "→ GET "+baseURL+"/echo/headers?api_key=***")
	headers := map[string]bool{}
	for _, line := range lines[1 : len(lines)-1] {
		headers[strings.ToLower(strings.TrimSpace(line))] = true
	}
	for _, want := range []string{"authorization: ***", "x-api-key: ***", "cookie: ***", "x-request-ids: r1"} {
		if !headers[want] {
			t.Errorf("missing %q in\n%s", want, logged)
		}
	}
	if last := lines[len(lines)-1]; !regexp.MustCompile(`^← 200 \(\d+ms\)$`).MatchString(last) {
		t.Errorf("last line %q", last)
	}
}

func TestSetsTheUserAgent(t *testing.T) {
	client := newClient(withMiddleware(core.UserAgent("archon-e2e/1.0")))
	echo, _, err := client.Echo.EchoHeadersCookies(ctx, edgecases.EchoHeadersCookiesParams{XRequestIds: []string{"r1"}, Theme: "dark"})
	noError(t, err)
	equal(t, echo.Headers["user-agent"], "archon-e2e/1.0")
}

func TestRunsMiddlewareInRegistrationOrderConfigFirstThenUse(t *testing.T) {
	var order []string
	tag := func(name string) core.Middleware {
		return func(req *core.Request, next core.Next, _ *core.CallContext) (*core.Response, error) {
			order = append(order, ">"+name)
			if trace := req.Header.Get("X-Trace"); trace != "" {
				req.Header.Set("X-Trace", trace+","+name)
			} else {
				req.Header.Set("X-Trace", name)
			}
			resp, err := next(req)
			order = append(order, "<"+name)
			return resp, err
		}
	}
	client := newClient(withMiddleware(tag("a"), tag("b")))
	client.Use(tag("c"))
	echo, _, err := client.Echo.EchoHeadersCookies(ctx, edgecases.EchoHeadersCookiesParams{XRequestIds: []string{"r1"}, Theme: "dark"})
	noError(t, err)
	equal(t, echo.Headers["x-trace"], "a,b,c")
	equal(t, strings.Join(order, " "), ">a >b >c <c <b <a")
}
