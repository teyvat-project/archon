package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func withAuth(auth *edgecases.Auth) func(*edgecases.ClientOptions) {
	return func(o *edgecases.ClientOptions) { o.Auth = auth }
}

func clientCredentials() *core.OAuth2 {
	return &core.OAuth2{ClientCredentials: &core.OAuth2ClientCredentials{ClientID: "client-id", ClientSecret: "client-secret"}}
}

func TestBearer(t *testing.T) {
	echo, resp, err := newClient(withAuth(&edgecases.Auth{BearerAuth: core.StaticToken("test-token")})).Auth.AuthBearer(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 200)
	equal(t, echo.Headers["authorization"], "Bearer test-token")
}

func TestBasic(t *testing.T) {
	_, resp, err := newClient(withAuth(&edgecases.Auth{BasicAuth: core.Basic{Username: "user", Password: "pass"}})).Auth.AuthBasic(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 200)
}

func TestAPIKeyInAHeader(t *testing.T) {
	echo, _, err := newClient(withAuth(&edgecases.Auth{ApiKeyHeader: core.StaticToken("test-key")})).Auth.AuthApiKeyHeader(ctx)
	noError(t, err)
	equal(t, echo.Headers["x-api-key"], "test-key")
}

func TestAPIKeyInTheQuery(t *testing.T) {
	provider := core.TokenFunc(func(context.Context) (string, error) { return "test-key", nil })
	echo, _, err := newClient(withAuth(&edgecases.Auth{ApiKeyQuery: provider})).Auth.AuthApiKeyQuery(ctx)
	noError(t, err)
	equal(t, echo.Query, "api_key=test-key")
}

func TestAPIKeyInACookie(t *testing.T) {
	echo, _, err := newClient(withAuth(&edgecases.Auth{ApiKeyCookie: core.StaticToken("test-key")})).Auth.AuthApiKeyCookie(ctx)
	noError(t, err)
	equal(t, len(echo.Cookies), 1)
	equal(t, echo.Cookies["session"], "test-key")
}

func TestRejectsAWrongCredentialWithATyped401(t *testing.T) {
	_, resp, err := newClient(withAuth(&edgecases.Auth{BearerAuth: core.StaticToken("wrong")})).Auth.AuthBearer(ctx)
	var apiErr *core.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("got %v", err)
	}
	equal(t, apiErr.StatusCode, 401)
	equal(t, resp.StatusCode, 401)
	body, ok := core.ErrorBody[*edgecases.Error](err)
	if !ok {
		t.Fatalf("body %v", apiErr.Body)
	}
	equal(t, body.Code, 401)
	equal(t, body.Message != "", true)
}

func TestReturnsAuthErrorWithoutSendingWhenRequiredAuthIsMissing(t *testing.T) {
	before := getStats(t).Requests["/auth/bearer"]
	_, resp, err := newClient().Auth.AuthBearer(ctx)
	var authErr *core.AuthError
	if !errors.As(err, &authErr) || resp != nil {
		t.Fatalf("got %v", err)
	}
	equal(t, strings.Join(authErr.Schemes, ","), "bearerAuth")
	equal(t, getStats(t).Requests["/auth/bearer"], before)
}

func TestSendsAnonymouslyWhenAuthIsOptionalAndNotConfigured(t *testing.T) {
	echo, _, err := newClient().Auth.AuthOptional(ctx)
	noError(t, err)
	if _, ok := echo.Headers["authorization"]; ok {
		t.Errorf("headers %v", echo.Headers)
	}
}

func TestUsesTheCredentialForOptionalAuthWhenItIsConfigured(t *testing.T) {
	echo, _, err := newClient(withAuth(&edgecases.Auth{BearerAuth: core.StaticToken("test-token")})).Auth.AuthOptional(ctx)
	noError(t, err)
	equal(t, echo.Headers["authorization"], "Bearer test-token")
}

func TestRequiresEverySchemeOfAnAndRequirement(t *testing.T) {
	before := getStats(t).Requests["/auth/and"]
	_, _, err := newClient(withAuth(&edgecases.Auth{BearerAuth: core.StaticToken("test-token")})).Auth.AuthAnd(ctx)
	var authErr *core.AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("got %v", err)
	}
	equal(t, getStats(t).Requests["/auth/and"], before)

	both := &edgecases.Auth{BearerAuth: core.StaticToken("test-token"), ApiKeyHeader: core.StaticToken("test-key")}
	_, resp, err := newClient(withAuth(both)).Auth.AuthAnd(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 200)
}

func TestOAuth2ObtainsATokenWithClientCredentialsFromTheRelativeTokenURL(t *testing.T) {
	before := getStats(t)
	echo, _, err := newClient(withAuth(&edgecases.Auth{Oauth2: clientCredentials()})).Auth.AuthOAuth2(ctx)
	noError(t, err)
	equal(t, strings.HasPrefix(echo.Headers["authorization"], "Bearer "), true)
	equal(t, getStats(t).TokensIssued, before.TokensIssued+1)
}

func TestOAuth2ObtainsATokenWithTheRefreshTokenGrant(t *testing.T) {
	var refreshed []string
	refresh := &core.OAuth2RefreshToken{
		RefreshToken: "test-refresh-token",
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		OnRefreshed:  func(tokens core.TokenSet) { refreshed = append(refreshed, tokens.RefreshToken) },
	}
	_, resp, err := newClient(withAuth(&edgecases.Auth{Oauth2: &core.OAuth2{RefreshToken: refresh}})).Auth.AuthOAuth2(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 200)
	equal(t, len(refreshed), 1)
	equal(t, refreshed[0] != "test-refresh-token" && refreshed[0] != "", true)
}

func TestOAuth2RenewsTheTokenBeforeItExpiresInsteadOfWaitingForA401(t *testing.T) {
	client := newClient(withAuth(&edgecases.Auth{Oauth2: clientCredentials()}))
	before := getStats(t)

	first, _, err := client.Auth.AuthOAuth2(ctx)
	noError(t, err)
	// The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
	time.Sleep(2100 * time.Millisecond)
	second, _, err := client.Auth.AuthOAuth2(ctx)
	noError(t, err)
	equal(t, first.Headers["authorization"] != second.Headers["authorization"], true)

	after := getStats(t)
	equal(t, after.TokensIssued-before.TokensIssued, 2)
	equal(t, after.Requests["/auth/oauth2"]-before.Requests["/auth/oauth2"], 2)
}

func TestOAuth2IssuesASingleTokenForConcurrentRequestsOnAColdClient(t *testing.T) {
	client := newClient(withAuth(&edgecases.Auth{Oauth2: clientCredentials()}))
	before := getStats(t)
	headers := make([]string, 5)
	errs := make([]error, 5)
	var wg sync.WaitGroup
	for i := range headers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			echo, _, err := client.Auth.AuthOAuth2(ctx)
			errs[i] = err
			if err == nil {
				headers[i] = echo.Headers["authorization"]
			}
		}(i)
	}
	wg.Wait()
	for i := range headers {
		noError(t, errs[i])
		equal(t, headers[i], headers[0])
	}
	equal(t, getStats(t).TokensIssued-before.TokensIssued, 1)
}
