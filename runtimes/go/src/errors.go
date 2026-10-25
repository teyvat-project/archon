package core

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// APIError is a non-2xx response. Body is the body decoded as the type declared for its status (a pointer, such
// as *NotFoundError), or nil when there is none or it could not be decoded; read it with ErrorBody.
type APIError struct {
	StatusCode int
	Header     http.Header
	// RawBody is the response body as received.
	RawBody []byte
	// URL is the final request URL.
	URL  string
	Body any
	// Err is why Body is nil although a type was declared for the status (the body was not that JSON).
	Err error
}

func (e *APIError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("HTTP %d (the error body is not the declared JSON: %v)", e.StatusCode, e.Err)
	}
	return fmt.Sprintf("HTTP %d", e.StatusCode)
}

func (e *APIError) Unwrap() error { return e.Err }

// ErrorBody returns the decoded body of the *APIError in err's chain when it is a T (such as *NotFoundError).
func ErrorBody[T any](err error) (T, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		if body, ok := apiErr.Body.(T); ok {
			return body, true
		}
	}
	var zero T
	return zero, false
}

// TransportError means the request could not be sent or the response could not be read (network failure,
// timeout, cancellation). Timeout is true when the client's Timeout elapsed; when the caller's context ended, Err
// is (or wraps) its error, so errors.Is(err, context.Canceled) holds.
type TransportError struct {
	Err     error
	Timeout bool
}

func (e *TransportError) Error() string {
	if e.Timeout {
		return fmt.Sprintf("request timed out: %v", e.Err)
	}
	return fmt.Sprintf("request failed: %v", e.Err)
}

func (e *TransportError) Unwrap() error { return e.Err }

// DecodeError is a successful response whose body could not be decoded.
type DecodeError struct {
	StatusCode int
	RawBody    []byte
	Err        error
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("failed to decode the response (HTTP %d): %v", e.StatusCode, e.Err)
}

func (e *DecodeError) Unwrap() error { return e.Err }

// AuthError means required credentials are not configured (returned before the request is sent), or a token
// request failed.
type AuthError struct {
	Schemes []string
	Message string
	Err     error
}

func (e *AuthError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *AuthError) Unwrap() error { return e.Err }

func missingCredentials(schemes []string) *AuthError {
	return &AuthError{Schemes: schemes, Message: "missing credentials for security scheme(s): " + strings.Join(schemes, ", ")}
}
