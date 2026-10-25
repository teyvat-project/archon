package core

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"strings"
)

// Decoder decodes a successful response body.
type Decoder[T any] func(status int, body []byte) (T, error)

// DecodeJSON decodes JSON into T. 204 / 205 / 304 and empty bodies decode to the zero value when T can be nil
// (a pointer, slice, map or interface) and fail with a *DecodeError otherwise.
func DecodeJSON[T any](status int, body []byte) (T, error) {
	var out T
	if status == http.StatusNoContent || status == http.StatusResetContent || status == http.StatusNotModified || len(body) == 0 {
		switch reflect.TypeFor[T]().Kind() {
		case reflect.Pointer, reflect.Slice, reflect.Map, reflect.Interface:
			return out, nil
		}
		return out, &DecodeError{StatusCode: status, RawBody: body, Err: errors.New("expected a JSON body but the response is empty")}
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, &DecodeError{StatusCode: status, RawBody: body, Err: err}
	}
	return out, nil
}

// DecodeText returns the body as text.
func DecodeText(_ int, body []byte) (string, error) { return string(body), nil }

// DecodeBinary returns the raw bytes.
func DecodeBinary(_ int, body []byte) ([]byte, error) { return body, nil }

// DecodeNone ignores the body (operations without response content).
func DecodeNone(int, []byte) (struct{}, error) { return struct{}{}, nil }

// ErrorDecoder decodes the body of a non-2xx response for APIError.Body.
type ErrorDecoder func(body []byte) (any, error)

// JSONError decodes the body as JSON into a new *T.
func JSONError[T any](body []byte) (any, error) {
	out := new(T)
	if err := json.Unmarshal(body, out); err != nil {
		return nil, err
	}
	return out, nil
}

// TextError keeps the body as a string.
func TextError(body []byte) (any, error) { return string(body), nil }

// ErrorDecoders are the error body decoders per status key ("404", "4XX", "default"; case-insensitive).
type ErrorDecoders map[string]ErrorDecoder

// newAPIError builds the error for a non-2xx response; a JSON error body that is empty or not the declared type
// leaves Body nil.
func (e ErrorDecoders) newAPIError(resp *Response) *APIError {
	err := &APIError{StatusCode: resp.StatusCode, Header: resp.Header, RawBody: resp.Body, URL: resp.URL}
	decode := e.lookup(strconv.Itoa(resp.StatusCode))
	if decode == nil {
		decode = e.lookup(strconv.Itoa(resp.StatusCode/100) + "XX")
	}
	if decode == nil {
		decode = e.lookup("default")
	}
	if decode == nil {
		return err
	}
	body, decodeErr := decode(resp.Body)
	switch {
	case decodeErr == nil:
		err.Body = body
	case len(resp.Body) > 0: // an empty body is simply absent
		err.Err = decodeErr
	}
	return err
}

func (e ErrorDecoders) lookup(key string) ErrorDecoder {
	for k, decode := range e {
		if strings.EqualFold(k, key) {
			return decode
		}
	}
	return nil
}
