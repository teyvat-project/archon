package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

type jsonKind int

const (
	jsonNull jsonKind = iota
	jsonBool
	jsonNumber
	jsonString
	jsonArray
	jsonObject
)

// jsonValue is a parsed JSON value that keeps the order of object members (a Go map would not), so parameters
// and form fields are written in declaration order.
type jsonValue struct {
	kind jsonKind
	// text is the string content, the number literal, or "true" / "false".
	text string
	// items are the array items, or the object member values (keys[i] names items[i]).
	items []jsonValue
	keys  []string
}

// toJSONValue converts v to its JSON form through encoding/json (so field tags, MarshalJSON and enums apply).
func toJSONValue(v any) (jsonValue, error) {
	data, err := marshalJSON(v)
	if err != nil {
		return jsonValue{}, err
	}
	return parseJSONValue(data)
}

// marshalJSON is json.Marshal without HTML escaping.
func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func parseJSONValue(data []byte) (jsonValue, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readJSONValue(dec)
	if err != nil {
		return jsonValue{}, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return jsonValue{}, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func readJSONValue(dec *json.Decoder) (jsonValue, error) {
	tok, err := dec.Token()
	if err != nil {
		return jsonValue{}, err
	}
	switch t := tok.(type) {
	case nil:
		return jsonValue{kind: jsonNull}, nil
	case bool:
		return jsonValue{kind: jsonBool, text: strconv.FormatBool(t)}, nil
	case json.Number:
		return jsonValue{kind: jsonNumber, text: t.String()}, nil
	case string:
		return jsonValue{kind: jsonString, text: t}, nil
	case json.Delim:
		if t == '[' {
			v := jsonValue{kind: jsonArray}
			for dec.More() {
				item, err := readJSONValue(dec)
				if err != nil {
					return jsonValue{}, err
				}
				v.items = append(v.items, item)
			}
			_, err := dec.Token()
			return v, err
		}
		v := jsonValue{kind: jsonObject}
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return jsonValue{}, err
			}
			item, err := readJSONValue(dec)
			if err != nil {
				return jsonValue{}, err
			}
			v.keys = append(v.keys, key.(string))
			v.items = append(v.items, item)
		}
		_, err := dec.Token()
		return v, err
	}
	return jsonValue{}, errors.New("unexpected JSON token")
}

// scalarText is the text of a value: strings unquoted, numbers as JavaScript prints them, booleans as
// true / false, arrays and objects as compact JSON.
func (v jsonValue) scalarText() string {
	switch v.kind {
	case jsonString, jsonBool:
		return v.text
	case jsonNumber:
		return jsNumber(v.text)
	case jsonNull:
		return "null"
	}
	var b strings.Builder
	v.writeJSON(&b)
	return b.String()
}

// writeJSON writes compact JSON (strings escaped like kotlinx.serialization / System.Text.Json relaxed do).
func (v jsonValue) writeJSON(b *strings.Builder) {
	switch v.kind {
	case jsonNull:
		b.WriteString("null")
	case jsonBool:
		b.WriteString(v.text)
	case jsonNumber:
		b.WriteString(jsNumber(v.text))
	case jsonString:
		writeJSONString(b, v.text)
	case jsonArray:
		b.WriteByte('[')
		for i, item := range v.items {
			if i > 0 {
				b.WriteByte(',')
			}
			item.writeJSON(b)
		}
		b.WriteByte(']')
	case jsonObject:
		b.WriteByte('{')
		for i, item := range v.items {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, v.keys[i])
			b.WriteByte(':')
			item.writeJSON(b)
		}
		b.WriteByte('}')
	}
}

func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

var integerLiteral = regexp.MustCompile(`^-?[0-9]+$`)

// jsNumber renders a JSON number literal as JavaScript's String(number) would; integer literals are kept as
// written (so int64 values keep every digit).
func jsNumber(literal string) string {
	if literal == "-0" {
		return "0"
	}
	if integerLiteral.MatchString(literal) {
		return literal
	}
	f, err := strconv.ParseFloat(literal, 64)
	if err != nil {
		return literal
	}
	return formatJSNumber(f)
}

// formatJSNumber is Number.prototype.toString: the shortest round-trip digits, exponent form below 1e-6 and from
// 1e21 on (encoding/json uses the same rules), and "0" for negative zero.
func formatJSNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return strconv.FormatFloat(f, 'g', -1, 64)
	}
	if f == 0 {
		return "0"
	}
	abs := math.Abs(f)
	format := byte('f')
	if abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	s := strconv.FormatFloat(f, format, -1, 64)
	if format == 'e' {
		// e-07 → e-7, e+21 stays.
		if i := strings.IndexByte(s, 'e'); i >= 0 && len(s) > i+3 && s[i+2] == '0' {
			s = s[:i+2] + s[i+3:]
		}
	}
	return s
}
