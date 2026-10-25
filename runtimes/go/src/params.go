package core

import (
	"fmt"
	"regexp"
	"strings"
)

// OpenAPI style / explode serialization (RFC 6570), matching the TypeScript, C# and Kotlin runtimes byte for byte.

var placeholder = regexp.MustCompile(`\{([^{}]+)}`)

func serializePath(template string, specs []ParamSpec, values *Values) (string, error) {
	byName := map[string]ParamSpec{}
	for _, spec := range specs {
		if spec.In == InPath {
			byName[spec.Name] = spec
		}
	}

	// Serialized values never contain '/', so template segments map 1:1 onto URL path segments.
	segments := strings.Split(template, "/")
	for i, segment := range segments {
		var used []string
		var failure error
		output := placeholder.ReplaceAllStringFunc(segment, func(match string) string {
			name := match[1 : len(match)-1]
			spec, ok := byName[name]
			if !ok {
				return match
			}
			value, ok := values.get(InPath, name)
			if !ok {
				if failure == nil {
					failure = fmt.Errorf("missing required path parameter %q", name)
				}
				return match
			}
			used = append(used, fmt.Sprintf("%q", name))
			return pathValue(spec, value)
		})
		if failure != nil {
			return "", failure
		}
		// URL parsers drop '.' / '..' segments (and '..' pops the parent), so such a value would leave its segment.
		if len(used) > 0 && (output == "" || output == "." || output == "..") {
			return "", fmt.Errorf("path parameter %s must not serialize to an empty, \".\" or \"..\" path segment", strings.Join(used, ", "))
		}
		segments[i] = output
	}
	return strings.Join(segments, "/"), nil
}

// serializeQuery returns the query string without '?' ("" when empty).
func serializeQuery(specs []ParamSpec, values *Values) string {
	return strings.Join(collect(specs, InQuery, values), "&")
}

// serializeHeader is the simple style without percent-encoding (header values are not URL-encoded); ok is false
// for null.
func serializeHeader(spec ParamSpec, value jsonValue) (string, bool, error) {
	var parts []string
	switch value.kind {
	case jsonNull:
		return "", false, nil
	case jsonArray:
		for _, item := range presentItems(value) {
			parts = append(parts, item.scalarText())
		}
	case jsonObject:
		for _, e := range presentEntries(value) {
			if spec.Explode {
				parts = append(parts, e.key+"="+e.value.scalarText())
			} else {
				parts = append(parts, e.key, e.value.scalarText())
			}
		}
	default:
		parts = []string{value.scalarText()}
	}
	text := strings.Join(parts, ",")
	if strings.ContainsAny(text, "\r\n") {
		return "", false, fmt.Errorf("header %q: values must not contain CR or LF", spec.Name)
	}
	return text, true, nil
}

// serializeCookie is the form style with values percent-encoded, pairs joined by "; " ("" when empty).
func serializeCookie(specs []ParamSpec, values *Values) string {
	return strings.Join(collect(specs, InCookie, values), "; ")
}

type entry struct {
	key   string
	value jsonValue
}

func presentItems(array jsonValue) []jsonValue {
	var out []jsonValue
	for _, item := range array.items {
		if item.kind != jsonNull {
			out = append(out, item)
		}
	}
	return out
}

func presentEntries(object jsonValue) []entry {
	var out []entry
	for i, item := range object.items {
		if item.kind != jsonNull {
			out = append(out, entry{object.keys[i], item})
		}
	}
	return out
}

func pathValue(spec ParamSpec, value jsonValue) string {
	// allowReserved only applies to query parameters; in a path it would let '/' '?' '#' escape the segment.
	enc := encodeComponent
	name := enc(spec.Name)
	explode := spec.Explode
	isArray := value.kind == jsonArray
	isObject := value.kind == jsonObject

	var items []string
	switch value.kind {
	case jsonArray:
		for _, item := range presentItems(value) {
			items = append(items, enc(item.scalarText()))
		}
	case jsonObject:
		for _, e := range presentEntries(value) {
			if explode {
				items = append(items, enc(e.key)+"="+enc(e.value.scalarText()))
			} else {
				items = append(items, enc(e.key), enc(e.value.scalarText()))
			}
		}
	default:
		items = []string{enc(value.scalarText())}
	}

	switch spec.Style {
	case StyleLabel:
		if explode {
			return "." + strings.Join(items, ".")
		}
		return "." + strings.Join(items, ",")
	case StyleMatrix:
		switch {
		case !isArray && !isObject:
			if items[0] == "" {
				return ";" + name
			}
			return ";" + name + "=" + items[0]
		case len(items) == 0:
			return ";" + name
		case !explode:
			return ";" + name + "=" + strings.Join(items, ",")
		case isArray:
			var b strings.Builder
			for _, item := range items {
				b.WriteString(";" + name + "=" + item)
			}
			return b.String()
		default:
			var b strings.Builder
			for _, item := range items {
				b.WriteString(";" + item)
			}
			return b.String()
		}
	}
	return strings.Join(items, ",")
}

func collect(specs []ParamSpec, in ParamLocation, values *Values) []string {
	var output []string
	for _, spec := range specs {
		if spec.In != in {
			continue
		}
		value, ok := values.get(in, spec.Name)
		if !ok {
			continue
		}
		output = append(output, formPairs(spec, value)...)
	}
	return output
}

// formPairs serializes one form-family parameter as already-encoded `name=value` strings.
func formPairs(spec ParamSpec, value jsonValue) []string {
	enc := encodeComponent
	if spec.In == InQuery && spec.AllowReserved {
		enc = encodeReserved
	}
	name := enc(spec.Name)
	explode := spec.Explode

	if spec.Style == StyleDeepObject && value.kind == jsonObject {
		var pairs []string
		deepObject(name, value, enc, &pairs)
		return pairs
	}

	// Exploded delimited styles are defined to behave like exploded form.
	separator := ","
	if !explode && spec.Style == StyleSpaceDelimited {
		separator = "%20"
	} else if !explode && spec.Style == StylePipeDelimited {
		separator = "|"
	}

	switch value.kind {
	case jsonArray:
		var encoded []string
		for _, item := range presentItems(value) {
			encoded = append(encoded, enc(item.scalarText()))
		}
		if !explode {
			return []string{name + "=" + strings.Join(encoded, separator)}
		}
		pairs := make([]string, len(encoded))
		for i, item := range encoded {
			pairs[i] = name + "=" + item
		}
		return pairs
	case jsonObject:
		var pairs, flat []string
		for _, e := range presentEntries(value) {
			pairs = append(pairs, enc(e.key)+"="+enc(e.value.scalarText()))
			flat = append(flat, enc(e.key), enc(e.value.scalarText()))
		}
		if explode {
			return pairs
		}
		return []string{name + "=" + strings.Join(flat, separator)}
	}
	return []string{name + "=" + enc(value.scalarText())}
}

func deepObject(prefix string, value jsonValue, enc func(string) string, output *[]string) {
	switch value.kind {
	case jsonObject:
		for _, e := range presentEntries(value) {
			deepObject(prefix+"["+enc(e.key)+"]", e.value, enc, output)
		}
	case jsonArray:
		for _, item := range presentItems(value) {
			deepObject(prefix, item, enc, output)
		}
	default:
		*output = append(*output, prefix+"="+enc(value.scalarText()))
	}
}
