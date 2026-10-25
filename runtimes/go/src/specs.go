// Package core is the runtime of an Archon-generated Go SDK: request building, parameter serialization,
// transport, authentication, middleware and errors. It only depends on the standard library.
package core

// ParamLocation is where a parameter is sent.
type ParamLocation int

const (
	InPath ParamLocation = iota
	InQuery
	InHeader
	InCookie
)

// ParamStyle is an OpenAPI parameter serialization style.
type ParamStyle int

const (
	StyleSimple ParamStyle = iota
	StyleLabel
	StyleMatrix
	StyleForm
	StyleSpaceDelimited
	StylePipeDelimited
	StyleDeepObject
)

// ParamSpec describes how one operation parameter is serialized.
type ParamSpec struct {
	Name          string
	In            ParamLocation
	Style         ParamStyle
	Explode       bool
	AllowReserved bool
}

// BodyKind is the encoding of a request body.
type BodyKind int

const (
	BodyNone BodyKind = iota
	BodyJSON
	BodyForm
	BodyMultipart
	BodyText
	BodyBinary
)

// ResponseKind is the decoding of a response body.
type ResponseKind int

const (
	ResponseEmpty ResponseKind = iota
	ResponseJSON
	ResponseText
	ResponseBinary
)

// SecuritySchemeKind is a kind of security scheme the runtime knows how to apply.
type SecuritySchemeKind int

const (
	// SchemeHTTPBearer sends `Authorization: Bearer <token>`.
	SchemeHTTPBearer SecuritySchemeKind = iota
	// SchemeHTTPBasic sends `Authorization: Basic <base64(user:pass)>`.
	SchemeHTTPBasic
	// SchemeAPIKey sends an API key in a header, the query string or a cookie.
	SchemeAPIKey
	// SchemeOAuth2 sends an OAuth2 access token as a bearer token.
	SchemeOAuth2
	// SchemeOpenIDConnect is treated like OAuth2, without discovery.
	SchemeOpenIDConnect
)

// APIKeyLocation is where an API key is sent.
type APIKeyLocation int

const (
	APIKeyInHeader APIKeyLocation = iota
	APIKeyInQuery
	APIKeyInCookie
)

// SecuritySchemeSpec is a security scheme of the API. TokenURL and RefreshURL are the spec's OAuth2 defaults
// (relative ones resolve against the base URL).
type SecuritySchemeSpec struct {
	Kind       SecuritySchemeKind
	In         APIKeyLocation
	Name       string
	TokenURL   string
	RefreshURL string
}

// SecurityScheme is one scheme of a security requirement, with the scopes it needs.
type SecurityScheme struct {
	Name   string
	Scopes []string
}

// SecurityRequirement is an AND of schemes. An empty requirement means the operation also accepts no
// authentication.
type SecurityRequirement []SecurityScheme

// OperationSpec is everything the runtime needs to know about one operation. Responses maps status keys
// ("200", "2XX", "default") to the kind of their content.
type OperationSpec struct {
	Name      string
	Method    string
	Path      string
	Tags      []string
	Security  []SecurityRequirement
	Params    []ParamSpec
	Body      BodyKind
	MediaType string
	Responses map[string]ResponseKind
}
