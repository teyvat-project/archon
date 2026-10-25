package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSelectsSecurityAlternatives(t *testing.T) {
	bearer := SecurityRequirement{{Name: "bearer"}}
	both := SecurityRequirement{{Name: "bearer"}, {Name: "key"}}
	none := func(string) bool { return false }
	onlyBearer := func(name string) bool { return name == "bearer" }

	if sel := selectSecurity(nil, none); sel.requirement != nil || sel.missing != nil {
		t.Errorf("no requirements: %+v", sel)
	}
	if sel := selectSecurity([]SecurityRequirement{bearer, {}}, none); sel.requirement != nil || sel.missing != nil {
		t.Errorf("optional: %+v", sel)
	}
	if sel := selectSecurity([]SecurityRequirement{bearer}, none); strings.Join(sel.missing, ",") != "bearer" {
		t.Errorf("missing: %+v", sel)
	}
	if sel := selectSecurity([]SecurityRequirement{both, bearer}, onlyBearer); len(sel.requirement) != 1 {
		t.Errorf("partial AND falls through: %+v", sel)
	}
}

func authOp(schemes ...string) *OperationSpec {
	op := getOp("/secure")
	var requirement SecurityRequirement
	for _, s := range schemes {
		requirement = append(requirement, SecurityScheme{Name: s, Scopes: []string{"read"}})
	}
	op.Security = []SecurityRequirement{requirement}
	return op
}

var testSchemes = map[string]SecuritySchemeSpec{
	"bearer": {Kind: SchemeHTTPBearer},
	"basic":  {Kind: SchemeHTTPBasic},
	"header": {Kind: SchemeAPIKey, In: APIKeyInHeader, Name: "X-API-Key"},
	"query":  {Kind: SchemeAPIKey, In: APIKeyInQuery, Name: "api_key"},
	"cookie": {Kind: SchemeAPIKey, In: APIKeyInCookie, Name: "session"},
	"oauth2": {Kind: SchemeOAuth2, TokenURL: "/oauth/token"},
}

func TestAppliesEachSchemeKind(t *testing.T) {
	s := newTestServer(t, nil)
	auth := testAuth{
		"bearer": TokenFunc(func(context.Context) (string, error) { return "from-provider", nil }),
		"basic":  Basic{Username: "user", Password: "päss"},
		"header": StaticToken("k1"),
		"query":  StaticToken("k 2"),
		"cookie": StaticToken("k;3"),
	}
	c := NewClient(Options{BaseURL: s.URL, Headers: map[string]string{"Cookie": "a=1"}, Auth: auth}, testSchemes)

	cases := map[string]func(recorded) bool{
		"bearer": func(r recorded) bool { return r.Header.Get("Authorization") == "Bearer from-provider" },
		"basic":  func(r recorded) bool { return r.Header.Get("Authorization") == "Basic dXNlcjpww6Rzcw==" },
		"header": func(r recorded) bool { return r.Header.Get("X-API-Key") == "k1" },
		"query":  func(r recorded) bool { return r.RequestURI == "/secure?api_key=k%202" },
		"cookie": func(r recorded) bool { return r.Header.Get("Cookie") == "a=1; session=k%3B3" },
	}
	for scheme, check := range cases {
		if _, _, err := Do(context.Background(), c, authOp(scheme), nil, DecodeNone, nil, nil); err != nil {
			t.Fatalf("%s: %v", scheme, err)
		}
		if got := s.last(t); !check(got) {
			t.Errorf("%s: %s %v", scheme, got.RequestURI, got.Header)
		}
	}
}

func TestReturnsAuthErrorBeforeSending(t *testing.T) {
	s := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL}, testSchemes)
	_, _, err := Do(context.Background(), c, authOp("bearer"), nil, DecodeNone, nil, nil)
	var authErr *AuthError
	if !errors.As(err, &authErr) || strings.Join(authErr.Schemes, ",") != "bearer" || len(s.received()) != 0 {
		t.Errorf("got %v (%d requests)", err, len(s.received()))
	}
}

func TestReappliesFreshCredentialsWhenMiddlewareSendsAgain(t *testing.T) {
	s := newTestServer(t, nil)
	var n atomic.Int32
	token := TokenFunc(func(context.Context) (string, error) { return fmt.Sprintf("t%d", n.Add(1)), nil })
	twice := func(req *Request, next Next, _ *CallContext) (*Response, error) {
		if _, err := next(req); err != nil {
			return nil, err
		}
		return next(req)
	}
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{twice}, Auth: testAuth{"bearer": token}}, testSchemes)
	if _, _, err := Do(context.Background(), c, authOp("bearer"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t).Header.Get("Authorization"); got != "Bearer t2" {
		t.Errorf("got %q", got)
	}
}

func TestCustomAuthCoversUnknownSchemes(t *testing.T) {
	s := newTestServer(t, nil)
	custom := func(req *Request, _ *CallContext) error {
		req.Header.Set("X-Digest", "yes")
		return nil
	}
	c := NewClient(Options{BaseURL: s.URL, CustomAuth: custom}, testSchemes)
	if _, _, err := Do(context.Background(), c, authOp("digest"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if s.last(t).Header.Get("X-Digest") != "yes" {
		t.Error("CustomAuth was not applied")
	}
}

// tokenServer is an OAuth2 token endpoint plus a protected resource accepting the tokens it issued.
type tokenServer struct {
	*testServer
	issued  atomic.Int32
	gate    chan struct{}
	expires int
	valid   sync.Map
}

func newTokenServer(t *testing.T) *tokenServer {
	ts := &tokenServer{expires: 3600}
	ts.testServer = newTestServer(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path != "/oauth/token" {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if _, ok := ts.valid.Load(token); !ok {
				reply(401, "application/json", `{}`)(w, r, nil)
				return
			}
			reply(200, "application/json", `{}`)(w, r, nil)
			return
		}
		if ts.gate != nil {
			<-ts.gate
		}
		form, _ := url.ParseQuery(string(body))
		n := ts.issued.Add(1)
		token := fmt.Sprintf("at-%d", n)
		ts.valid.Store(token, true)
		out := map[string]any{"access_token": token, "expires_in": ts.expires, "scope": form.Get("scope")}
		if form.Get("grant_type") == "refresh_token" {
			out["refresh_token"] = fmt.Sprintf("rt-%d", n)
		}
		data, _ := json.Marshal(out)
		reply(200, "application/json", string(data))(w, r, nil)
	})
	return ts
}

func TestOAuth2ClientCredentials(t *testing.T) {
	ts := newTokenServer(t)
	creds := &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id", ClientSecret: "secret", Scopes: []string{"extra"}}}
	c := NewClient(Options{BaseURL: ts.URL, Auth: testAuth{"oauth2": creds}}, testSchemes)
	for i := 0; i < 2; i++ {
		if _, _, err := Do(context.Background(), c, authOp("oauth2"), nil, DecodeNone, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	token := ts.received()[0]
	form, _ := url.ParseQuery(string(token.Body))
	if token.Header.Get("Authorization") != "Basic aWQ6c2VjcmV0" || form.Get("grant_type") != "client_credentials" || form.Get("scope") != "extra read" {
		t.Errorf("token request: %v %s", token.Header, token.Body)
	}
	if ts.issued.Load() != 1 || ts.last(t).Header.Get("Authorization") != "Bearer at-1" {
		t.Errorf("issued %d", ts.issued.Load())
	}
}

func TestOAuth2RenewsAheadOfExpiry(t *testing.T) {
	ts := newTokenServer(t)
	ts.expires = 60
	now := time.Unix(1000, 0)
	m := NewTokenManager(nil, &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id", ClientSecret: "s"}}, ts.URL+"/oauth/token", "", "oauth2",
		TokenManagerOptions{Now: func() time.Time { return now }})
	first, _ := m.Token(context.Background(), nil)
	now = now.Add(29 * time.Second)
	if again, _ := m.Token(context.Background(), nil); again != first {
		t.Error("the token is still fresh 31s before it expires")
	}
	now = now.Add(2 * time.Second)
	if renewed, _ := m.Token(context.Background(), nil); renewed == first {
		t.Error("the token must be renewed 30s before it expires")
	}
}

func TestOAuth2SingleFlightAndCancellation(t *testing.T) {
	ts := newTokenServer(t)
	ts.gate = make(chan struct{})
	m := NewTokenManager(nil, &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id", ClientSecret: "s"}}, ts.URL+"/oauth/token", "", "oauth2", TokenManagerOptions{})

	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan string, 5)
	cancelled := make(chan error, 1)
	go func() {
		_, err := m.Token(ctx, nil)
		cancelled <- err
	}()
	for i := 0; i < 4; i++ {
		go func() {
			token, err := m.Token(context.Background(), nil)
			if err != nil {
				token = err.Error()
			}
			results <- token
		}()
	}
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Errorf("the cancelled caller got %v", err)
	}
	close(ts.gate)
	for i := 0; i < 4; i++ {
		if token := <-results; token != "at-1" {
			t.Errorf("waiter got %q", token)
		}
	}
	if ts.issued.Load() != 1 {
		t.Errorf("issued %d tokens", ts.issued.Load())
	}
}

func TestOAuth2RefreshTokenGrantRotates(t *testing.T) {
	ts := newTokenServer(t)
	var refreshed []string
	cfg := &OAuth2{RefreshToken: &OAuth2RefreshToken{RefreshToken: "rt-0", ClientID: "id", ClientAuth: ClientAuthPost, OnRefreshed: func(s TokenSet) {
		refreshed = append(refreshed, s.RefreshToken)
	}}}
	// A relative token URL resolves against the base URL.
	m := NewTokenManager(nil, cfg, "/oauth/token", ts.URL+"/api", "oauth2", TokenManagerOptions{})
	if _, err := m.Token(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	m.Invalidate("")
	if _, err := m.Token(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	requests := ts.received()
	first, _ := url.ParseQuery(string(requests[0].Body))
	second, _ := url.ParseQuery(string(requests[1].Body))
	if first.Get("refresh_token") != "rt-0" || second.Get("refresh_token") != "rt-1" || first.Get("client_id") != "id" || requests[0].Header.Get("Authorization") != "" {
		t.Errorf("requests: %s / %s", requests[0].Body, requests[1].Body)
	}
	if strings.Join(refreshed, ",") != "rt-1,rt-2" {
		t.Errorf("refreshed %v", refreshed)
	}
}

func TestOAuth2RetriesOnceOn401AndRebuildsForANewValue(t *testing.T) {
	ts := newTokenServer(t)
	auth := testAuth{"oauth2": &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id", ClientSecret: "s"}}}
	c := NewClient(Options{BaseURL: ts.URL, Auth: auth}, testSchemes)
	if _, _, err := Do(context.Background(), c, authOp("oauth2"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	ts.valid.Delete("at-1") // revoked server-side
	if _, _, err := Do(context.Background(), c, authOp("oauth2"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if ts.issued.Load() != 2 {
		t.Errorf("issued %d", ts.issued.Load())
	}
	auth["oauth2"] = &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id", ClientSecret: "s"}}
	if _, _, err := Do(context.Background(), c, authOp("oauth2"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if ts.issued.Load() != 3 {
		t.Errorf("a replaced value must get its own manager (issued %d)", ts.issued.Load())
	}
}

func TestOAuth2TokenEndpointFailures(t *testing.T) {
	cases := map[string]func(http.ResponseWriter, *http.Request, []byte){
		"status":       reply(400, "application/json", `{"error":"invalid_client"}`),
		"invalid json": reply(200, "application/json", `{`),
		"no token":     reply(200, "application/json", `{"token_type":"Bearer"}`),
	}
	for name, handle := range cases {
		s := newTestServer(t, handle)
		m := NewTokenManager(nil, &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id"}}, s.URL, "", "oauth2", TokenManagerOptions{})
		var authErr *AuthError
		if _, err := m.Token(context.Background(), nil); !errors.As(err, &authErr) || authErr.Schemes[0] != "oauth2" {
			t.Errorf("%s: %v", name, err)
		}
	}
	m := NewTokenManager(nil, &OAuth2{ClientCredentials: &OAuth2ClientCredentials{ClientID: "id"}}, "/relative", "", "oauth2", TokenManagerOptions{})
	if _, err := m.Token(context.Background(), nil); err == nil {
		t.Error("a relative token URL without a base URL must fail")
	}
}
