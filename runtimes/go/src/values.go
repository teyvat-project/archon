package core

import (
	"errors"
	"fmt"
)

type valueKey struct {
	in   ParamLocation
	name string
}

// Values holds the parameter values and the body of one call. Values are converted to JSON through
// encoding/json, so the parameter serializer sees struct fields in declaration order and enums as their raw
// values; nil (and JSON null) values are not sent.
type Values struct {
	params map[valueKey]jsonValue
	body   func(mediaType string) Body
	err    error
}

// NewValues returns an empty set of values.
func NewValues() *Values {
	return &Values{params: map[valueKey]jsonValue{}}
}

func (v *Values) Path(name string, value any) *Values   { return v.add(InPath, name, value) }
func (v *Values) Query(name string, value any) *Values  { return v.add(InQuery, name, value) }
func (v *Values) Header(name string, value any) *Values { return v.add(InHeader, name, value) }
func (v *Values) Cookie(name string, value any) *Values { return v.add(InCookie, name, value) }

// JSONBody sets a JSON body.
func (v *Values) JSONBody(value any) *Values {
	data, err := marshalJSON(value)
	if err != nil {
		return v.fail(fmt.Errorf("encoding the request body: %w", err))
	}
	v.body = func(mediaType string) Body { return NewBytesBody(data, orDefault(mediaType, "application/json")) }
	return v
}

// FormBody sets an application/x-www-form-urlencoded body from the value's JSON properties.
func (v *Values) FormBody(value any) *Values {
	object, err := toJSONValue(value)
	if err != nil {
		return v.fail(fmt.Errorf("encoding the request body: %w", err))
	}
	if object.kind != jsonObject {
		return v.fail(errors.New("a form body must be a JSON object"))
	}
	form := formFromJSON(object)
	v.body = func(string) Body { return form }
	return v
}

// TextBody sets a text body.
func (v *Values) TextBody(value string) *Values {
	v.body = func(mediaType string) Body { return NewBytesBody([]byte(value), orDefault(mediaType, "text/plain")) }
	return v
}

// BinaryBody sets a raw body, sent with the operation's media type (the file's content type when the operation
// has none).
func (v *Values) BinaryBody(file File) *Values {
	v.body = func(mediaType string) Body {
		return NewBytesBody(file.Content, orDefault(mediaType, orDefault(file.ContentType, "application/octet-stream")))
	}
	return v
}

// Body sets a body built by hand (multipart, a stream, ...).
func (v *Values) Body(body Body) *Values {
	v.body = func(string) Body { return body }
	return v
}

func (v *Values) get(in ParamLocation, name string) (jsonValue, bool) {
	value, ok := v.params[valueKey{in, name}]
	return value, ok
}

func (v *Values) add(in ParamLocation, name string, value any) *Values {
	converted, err := toJSONValue(value)
	if err != nil {
		return v.fail(fmt.Errorf("encoding parameter %q: %w", name, err))
	}
	if converted.kind != jsonNull {
		v.params[valueKey{in, name}] = converted
	}
	return v
}

func (v *Values) fail(err error) *Values {
	if v.err == nil {
		v.err = err
	}
	return v
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
