package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TokenSet is a token response; a zero ExpiresAt means the token does not expire.
type TokenSet struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scope        string
}

// TokenManagerOptions tunes a TokenManager; zero values use the defaults.
type TokenManagerOptions struct {
	// Now is the clock (default time.Now).
	Now func() time.Time
	// Leeway renews tokens this long before they expire (default 30s).
	Leeway time.Duration
	// Timeout bounds each token request (default: none; the caller's context does not apply, see Token).
	Timeout time.Duration
}

// TokenManager obtains and caches OAuth2 access tokens through the client credentials or refresh token grant.
// Tokens are renewed Leeway before they expire; concurrent requests for the same scopes share one token request,
// which runs on its own goroutine so a caller whose context ends stops waiting without failing the others.
type TokenManager struct {
	http     *http.Client
	config   *OAuth2
	tokenURL string
	baseURL  string
	schemes  []string
	now      func() time.Time
	leeway   time.Duration
	timeout  time.Duration

	mu           sync.Mutex
	cache        map[string]TokenSet
	inflight     map[string]*tokenCall
	refreshToken string
}

type tokenCall struct {
	done   chan struct{}
	tokens TokenSet
	err    error
}

// NewTokenManager returns a manager for config. tokenURL is the spec's token URL, used when the grant configures
// none; relative token URLs resolve against baseURL.
func NewTokenManager(httpClient *http.Client, config *OAuth2, tokenURL, baseURL, scheme string, options TokenManagerOptions) *TokenManager {
	m := &TokenManager{
		http:     httpClient,
		config:   config,
		tokenURL: tokenURL,
		baseURL:  baseURL,
		schemes:  []string{scheme},
		now:      options.Now,
		leeway:   options.Leeway,
		timeout:  options.Timeout,
		cache:    map[string]TokenSet{},
		inflight: map[string]*tokenCall{},
	}
	if m.http == nil {
		m.http = &http.Client{}
	}
	if m.now == nil {
		m.now = time.Now
	}
	if m.leeway == 0 {
		m.leeway = 30 * time.Second
	}
	if config.RefreshToken != nil {
		m.refreshToken = config.RefreshToken.RefreshToken
	}
	return m
}

// Token returns a cached token for the scopes, or obtains one.
func (m *TokenManager) Token(ctx context.Context, scopes []string) (string, error) {
	requested := append([]string(nil), scopes...)
	if m.config.ClientCredentials != nil {
		requested = append(requested, m.config.ClientCredentials.Scopes...)
	}
	slices.Sort(requested)
	requested = slices.Compact(requested)
	key := strings.Join(requested, " ")
	if m.config.RefreshToken != nil {
		key = ""
	}

	m.mu.Lock()
	if tokens, ok := m.cache[key]; ok && m.fresh(tokens) {
		m.mu.Unlock()
		return tokens.AccessToken, nil
	}
	call, ok := m.inflight[key]
	if !ok {
		call = &tokenCall{done: make(chan struct{})}
		m.inflight[key] = call
		go m.fetchAndStore(context.WithoutCancel(ctx), key, requested, call)
	}
	m.mu.Unlock()

	// Only this caller stops waiting when its context ends; the fetch goes on for the others.
	select {
	case <-call.done:
		return call.tokens.AccessToken, call.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Invalidate drops cached tokens so the next request fetches a new one. With a rejected token only entries
// holding that token are dropped, so a caller holding a stale token cannot discard a newer one.
func (m *TokenManager) Invalidate(rejected string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, tokens := range m.cache {
		if rejected == "" || tokens.AccessToken == rejected {
			delete(m.cache, key)
		}
	}
}

func (m *TokenManager) fresh(tokens TokenSet) bool {
	return tokens.ExpiresAt.IsZero() || tokens.ExpiresAt.Add(-m.leeway).After(m.now())
}

func (m *TokenManager) fetchAndStore(ctx context.Context, key string, scopes []string, call *tokenCall) {
	tokens, err := m.fetch(ctx, scopes)
	m.mu.Lock()
	if err == nil {
		m.cache[key] = tokens
	}
	// Before the waiters wake up, so later callers find the cached token or start a new fetch.
	delete(m.inflight, key)
	m.mu.Unlock()
	call.tokens, call.err = tokens, err
	close(call.done)
}

func (m *TokenManager) fail(message string, err error) error {
	return &AuthError{Schemes: m.schemes, Message: message, Err: err}
}

func (m *TokenManager) fetch(ctx context.Context, scopes []string) (TokenSet, error) {
	refresh := m.config.RefreshToken
	credentials := m.config.ClientCredentials
	if refresh == nil && credentials == nil {
		return TokenSet{}, m.fail("the OAuth2 scheme has neither ClientCredentials nor RefreshToken configured", nil)
	}
	configured := m.tokenURL
	var clientID, clientSecret string
	var clientAuth OAuth2ClientAuth
	form := NewFormBody()
	if refresh != nil {
		configured = orDefault(refresh.TokenURL, configured)
		clientID, clientSecret, clientAuth = refresh.ClientID, refresh.ClientSecret, refresh.ClientAuth
		m.mu.Lock()
		current := m.refreshToken
		m.mu.Unlock()
		form.Add("grant_type", "refresh_token").Add("refresh_token", current)
	} else {
		configured = orDefault(credentials.TokenURL, configured)
		clientID, clientSecret, clientAuth = credentials.ClientID, credentials.ClientSecret, credentials.ClientAuth
		form.Add("grant_type", "client_credentials")
		if len(scopes) > 0 {
			form.Add("scope", strings.Join(scopes, " "))
		}
	}
	if configured == "" {
		return TokenSet{}, m.fail("no token URL is configured for the OAuth2 token request", nil)
	}
	tokenURL, err := m.resolveTokenURL(configured)
	if err != nil {
		return TokenSet{}, err
	}
	authorization := ""
	if clientSecret != "" && clientAuth == ClientAuthBasic {
		authorization = "Basic " + base64.StdEncoding.EncodeToString([]byte(clientID+":"+clientSecret))
	} else {
		form.Add("client_id", clientID)
		if clientSecret != "" {
			form.Add("client_secret", clientSecret)
		}
	}

	if m.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, m.timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.encode()))
	if err != nil {
		return TokenSet{}, m.fail("the token request could not be created", err)
	}
	req.Header.Set("Content-Type", form.ContentType())
	req.Header.Set("Accept", "application/json")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return TokenSet{}, m.fail("the token request failed", err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return TokenSet{}, m.fail("the token response could not be read", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return TokenSet{}, m.fail("the token endpoint responded with HTTP "+resp.Status, nil)
	}

	var data map[string]json.RawMessage
	if err := json.Unmarshal(body, &data); err != nil {
		return TokenSet{}, m.fail("the token endpoint returned a response that is not a JSON object", err)
	}
	str := func(name string) string {
		var s string
		_ = json.Unmarshal(data[name], &s)
		return s
	}
	tokens := TokenSet{AccessToken: str("access_token"), RefreshToken: str("refresh_token"), Scope: str("scope")}
	if tokens.AccessToken == "" {
		return TokenSet{}, m.fail("the token endpoint response has no access_token", nil)
	}
	if expiresIn, ok := seconds(data["expires_in"]); ok {
		tokens.ExpiresAt = m.now().Add(time.Duration(expiresIn * float64(time.Second)))
	}
	if tokens.RefreshToken != "" && refresh != nil {
		m.mu.Lock()
		m.refreshToken = tokens.RefreshToken
		m.mu.Unlock()
		if refresh.OnRefreshed != nil {
			refresh.OnRefreshed(tokens)
		}
	}
	return tokens, nil
}

// resolveTokenURL uses an absolute URL as is and resolves a relative one against the base URL.
func (m *TokenManager) resolveTokenURL(raw string) (string, error) {
	if requireAbsolute(raw) == nil {
		return raw, nil
	}
	if requireAbsolute(m.baseURL) != nil {
		return "", m.fail("cannot resolve the relative token URL "+raw+" without an absolute base URL", nil)
	}
	return resolveURL(m.baseURL, raw), nil
}

// seconds reads expires_in, a JSON number or a numeric string.
func seconds(raw json.RawMessage) (float64, bool) {
	var number float64
	if json.Unmarshal(raw, &number) != nil {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	}
	return number, !math.IsInf(number, 0) && !math.IsNaN(number)
}
