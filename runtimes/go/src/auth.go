package core

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
)

// TokenProvider supplies a bearer token or an API key; it is called on every send.
type TokenProvider interface {
	Token(ctx context.Context) (string, error)
}

// StaticToken is a fixed bearer token or API key.
type StaticToken string

// Token returns the token itself.
func (t StaticToken) Token(context.Context) (string, error) { return string(t), nil }

// TokenFunc supplies a token from a function called on every send.
type TokenFunc func(ctx context.Context) (string, error)

// Token calls f.
func (f TokenFunc) Token(ctx context.Context) (string, error) { return f(ctx) }

// BasicProvider supplies HTTP Basic credentials; it is called on every send.
type BasicProvider interface {
	Credentials(ctx context.Context) (Basic, error)
}

// Basic is a fixed pair of HTTP Basic credentials.
type Basic struct {
	Username string
	Password string
}

// Credentials returns the credentials themselves.
func (b Basic) Credentials(context.Context) (Basic, error) { return b, nil }

// BasicFunc supplies HTTP Basic credentials from a function called on every send.
type BasicFunc func(ctx context.Context) (Basic, error)

// Credentials calls f.
func (f BasicFunc) Credentials(ctx context.Context) (Basic, error) { return f(ctx) }

// OAuth2ClientAuth is how the client authenticates at the token endpoint.
type OAuth2ClientAuth int

const (
	// ClientAuthBasic sends `Authorization: Basic` (client_secret_basic).
	ClientAuthBasic OAuth2ClientAuth = iota
	// ClientAuthPost sends client_id / client_secret in the form (client_secret_post).
	ClientAuthPost
)

// OAuth2ClientCredentials runs the client credentials grant.
type OAuth2ClientCredentials struct {
	ClientID     string
	ClientSecret string
	// Scopes are requested in addition to those the operation needs.
	Scopes []string
	// TokenURL overrides the spec's token URL (relative URLs resolve against the base URL).
	TokenURL   string
	ClientAuth OAuth2ClientAuth
}

// OAuth2RefreshToken runs the refresh token grant.
type OAuth2RefreshToken struct {
	RefreshToken string
	ClientID     string
	// ClientSecret is optional (public clients send only client_id).
	ClientSecret string
	TokenURL     string
	ClientAuth   OAuth2ClientAuth
	// OnRefreshed is called after every token response that carries a (rotated) refresh token. It runs on the
	// goroutine fetching the token, not the caller's.
	OnRefreshed func(tokens TokenSet)
}

// OAuth2 holds OAuth2 / OpenID Connect credentials: a ready access token, or a grant the runtime runs and caches.
type OAuth2 struct {
	AccessToken       TokenProvider
	ClientCredentials *OAuth2ClientCredentials
	RefreshToken      *OAuth2RefreshToken
}

func (o *OAuth2) configured() bool {
	return o != nil && (o.AccessToken != nil || o.ClientCredentials != nil || o.RefreshToken != nil)
}

// selection is which alternative of an operation's security requirements to apply: requirement (nil for
// anonymous), or the schemes missing for the first alternative.
type selection struct {
	requirement SecurityRequirement
	missing     []string
}

// selectSecurity evaluates the OR-of-AND requirements in order and picks the first alternative whose schemes are
// all configured. An empty alternative (optional auth) is used only when no other one is satisfiable.
func selectSecurity(requirements []SecurityRequirement, configured func(string) bool) selection {
	optional := false
	var first SecurityRequirement
	for _, requirement := range requirements {
		if len(requirement) == 0 {
			optional = true
			continue
		}
		if first == nil {
			first = requirement
		}
		all := true
		for _, scheme := range requirement {
			all = all && configured(scheme.Name)
		}
		if all {
			return selection{requirement: requirement}
		}
	}
	if first == nil || optional {
		return selection{}
	}
	var missing []string
	for _, scheme := range first {
		if !configured(scheme.Name) {
			missing = append(missing, scheme.Name)
		}
	}
	return selection{missing: missing}
}

// authState applies authentication innermost in the chain (spec §8.2) and refreshes managed OAuth2 tokens once
// on 401.
type authState struct {
	client *Client

	mu       sync.Mutex
	managers map[string]managerEntry
}

// managerEntry is a token manager and the value it was built from: a scheme's value can be replaced on the same
// Auth, and a manager serves only its own.
type managerEntry struct {
	value   *OAuth2
	manager *TokenManager
}

type usedToken struct {
	manager *TokenManager
	token   string
}

func (a *authState) intercept(req *Request, next Next, ctx *CallContext) (*Response, error) {
	sel := selectSecurity(ctx.Security, a.isConfigured)
	if sel.missing != nil {
		return nil, missingCredentials(sel.missing)
	}
	used, err := a.apply(req, sel.requirement, ctx)
	if err != nil {
		return nil, err
	}
	resp, err := next(req)
	if err != nil || resp == nil || resp.StatusCode != 401 || len(used) == 0 || !req.Replayable() {
		return resp, err
	}
	for _, u := range used {
		u.manager.Invalidate(u.token)
	}
	if _, err := a.apply(req, sel.requirement, ctx); err != nil {
		return nil, err
	}
	return next(req)
}

func (a *authState) value(scheme string) any {
	if auth := a.client.options.Auth; auth != nil {
		return auth.Get(scheme)
	}
	return nil
}

func (a *authState) isConfigured(scheme string) bool {
	spec, ok := a.client.schemes[scheme]
	if !ok {
		// Schemes the generator cannot apply (http digest, mutualTLS, ...) are left out of the scheme table;
		// CustomAuth is responsible for them.
		return a.client.options.CustomAuth != nil
	}
	switch v := a.value(scheme).(type) {
	case *OAuth2:
		return (spec.Kind == SchemeOAuth2 || spec.Kind == SchemeOpenIDConnect) && v.configured()
	case TokenProvider:
		return spec.Kind == SchemeHTTPBearer || spec.Kind == SchemeAPIKey
	case BasicProvider:
		return spec.Kind == SchemeHTTPBasic
	}
	return false
}

// apply applies the requirement; it returns each token manager used with the token it supplied.
func (a *authState) apply(req *Request, requirement SecurityRequirement, ctx *CallContext) ([]usedToken, error) {
	var used []usedToken
	for _, scheme := range requirement {
		spec, ok := a.client.schemes[scheme.Name]
		if !ok {
			continue // left to CustomAuth
		}
		fail := func(err error) error {
			if ctxErr := ctx.Context.Err(); ctxErr != nil {
				return &TransportError{Err: ctxErr}
			}
			var authErr *AuthError
			if errors.As(err, &authErr) {
				return err
			}
			return &AuthError{Schemes: []string{scheme.Name}, Message: "obtaining credentials for security scheme " + scheme.Name, Err: err}
		}
		switch spec.Kind {
		case SchemeHTTPBearer:
			token, err := a.value(scheme.Name).(TokenProvider).Token(ctx.Context)
			if err != nil {
				return nil, fail(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
		case SchemeHTTPBasic:
			basic, err := a.value(scheme.Name).(BasicProvider).Credentials(ctx.Context)
			if err != nil {
				return nil, fail(err)
			}
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(basic.Username+":"+basic.Password)))
		case SchemeAPIKey:
			key, err := a.value(scheme.Name).(TokenProvider).Token(ctx.Context)
			if err != nil {
				return nil, fail(err)
			}
			switch spec.In {
			case APIKeyInHeader:
				req.Header.Set(spec.Name, key)
			case APIKeyInQuery:
				req.SetQueryParameter(spec.Name, key)
			case APIKeyInCookie:
				setCookie(req.Header, spec.Name, encodeComponent(key))
			}
		case SchemeOAuth2, SchemeOpenIDConnect:
			oauth := a.value(scheme.Name).(*OAuth2)
			var token string
			var err error
			if oauth.AccessToken != nil {
				token, err = oauth.AccessToken.Token(ctx.Context)
			} else {
				manager := a.manager(scheme.Name, spec, oauth)
				token, err = manager.Token(ctx.Context, scheme.Scopes)
				used = append(used, usedToken{manager, token})
			}
			if err != nil {
				return nil, fail(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	if custom := a.client.options.CustomAuth; custom != nil {
		if err := custom(req, ctx); err != nil {
			return nil, err
		}
	}
	return used, nil
}

func (a *authState) manager(scheme string, spec SecuritySchemeSpec, value *OAuth2) *TokenManager {
	a.mu.Lock()
	defer a.mu.Unlock()
	if entry, ok := a.managers[scheme]; ok && entry.value == value {
		return entry.manager
	}
	specURL := spec.TokenURL
	if value.RefreshToken != nil && spec.RefreshURL != "" {
		specURL = spec.RefreshURL
	}
	options := a.client.options
	manager := NewTokenManager(a.client.http, value, specURL, options.BaseURL, scheme, TokenManagerOptions{Timeout: options.Timeout})
	if a.managers == nil {
		a.managers = map[string]managerEntry{}
	}
	a.managers[scheme] = managerEntry{value, manager}
	return manager
}

func setCookie(header http.Header, name, value string) {
	var kept []string
	for _, part := range strings.Split(header.Get("Cookie"), ";") {
		part = strings.TrimSpace(part)
		if part != "" && strings.SplitN(part, "=", 2)[0] != name {
			kept = append(kept, part)
		}
	}
	header.Set("Cookie", strings.Join(append(kept, name+"="+value), "; "))
}
