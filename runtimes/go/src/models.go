package core

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Helpers for the generated models.

// CheckRequired fails when the JSON object data lacks one of the required properties, or holds null for one of
// those that are not nullable. Values that are not objects (and null) pass, so json.Unmarshal reports them.
func CheckRequired(data []byte, nonNull []string, nullable []string) error {
	if JSONType(data) != "object" {
		return nil
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil {
		return err
	}
	for _, name := range nonNull {
		raw, ok := members[name]
		if !ok {
			return fmt.Errorf("missing required property %q", name)
		}
		if string(raw) == "null" {
			return fmt.Errorf("required property %q is null", name)
		}
	}
	for _, name := range nullable {
		if _, ok := members[name]; !ok {
			return fmt.Errorf("missing required property %q", name)
		}
	}
	return nil
}

// Discriminator returns the string value of property in the JSON object data ("" when it is absent or not a
// string).
func Discriminator(data []byte, property string) string {
	if JSONType(data) != "object" {
		return ""
	}
	var members map[string]json.RawMessage
	if json.Unmarshal(data, &members) != nil {
		return ""
	}
	var tag string
	if json.Unmarshal(members[property], &tag) != nil {
		return ""
	}
	return tag
}

// JSONType is the type of the JSON value data: "object", "array", "string", "number", "boolean" or "null" ("" for
// anything else).
func JSONType(data []byte) string {
	data = bytes.TrimLeft(data, " \t\r\n")
	if len(data) == 0 {
		return ""
	}
	switch c := data[0]; {
	case c == '{':
		return "object"
	case c == '[':
		return "array"
	case c == '"':
		return "string"
	case c == 't' || c == 'f':
		return "boolean"
	case c == 'n':
		return "null"
	case c == '-' || '0' <= c && c <= '9':
		return "number"
	}
	return ""
}
