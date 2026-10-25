package core

import (
	"errors"
	"math"
	"strings"
	"testing"
)

type rgb struct {
	R int `json:"R"`
	G int `json:"G"`
	B int `json:"B"`
}

var colors = []string{"blue", "black", "brown"}

func colorValue(kind string) any {
	switch kind {
	case "string":
		return "blue"
	case "array":
		return colors
	}
	return rgb{100, 200, 150}
}

func TestSerializesPathStyles(t *testing.T) {
	cases := []struct {
		style   ParamStyle
		explode bool
		kind    string
		want    string
	}{
		{StyleMatrix, false, "string", ";color=blue"},
		{StyleMatrix, false, "array", ";color=blue,black,brown"},
		{StyleMatrix, false, "object", ";color=R,100,G,200,B,150"},
		{StyleMatrix, true, "string", ";color=blue"},
		{StyleMatrix, true, "array", ";color=blue;color=black;color=brown"},
		{StyleMatrix, true, "object", ";R=100;G=200;B=150"},
		{StyleLabel, false, "string", ".blue"},
		{StyleLabel, false, "array", ".blue,black,brown"},
		{StyleLabel, false, "object", ".R,100,G,200,B,150"},
		{StyleLabel, true, "string", ".blue"},
		{StyleLabel, true, "array", ".blue.black.brown"},
		{StyleLabel, true, "object", ".R=100.G=200.B=150"},
		{StyleSimple, false, "string", "blue"},
		{StyleSimple, false, "array", "blue,black,brown"},
		{StyleSimple, false, "object", "R,100,G,200,B,150"},
		{StyleSimple, true, "string", "blue"},
		{StyleSimple, true, "array", "blue,black,brown"},
		{StyleSimple, true, "object", "R=100,G=200,B=150"},
	}
	for _, c := range cases {
		spec := ParamSpec{Name: "color", In: InPath, Style: c.style, Explode: c.explode}
		got, err := serializePath("{color}", []ParamSpec{spec}, NewValues().Path("color", colorValue(c.kind)))
		if err != nil || got != c.want {
			t.Errorf("style %d explode=%v %s: got %q (%v), want %q", c.style, c.explode, c.kind, got, err, c.want)
		}
	}
}

func TestSerializesQueryStyles(t *testing.T) {
	cases := []struct {
		style   ParamStyle
		explode bool
		kind    string
		want    string
	}{
		{StyleForm, false, "string", "color=blue"},
		{StyleForm, false, "array", "color=blue,black,brown"},
		{StyleForm, false, "object", "color=R,100,G,200,B,150"},
		{StyleForm, true, "string", "color=blue"},
		{StyleForm, true, "array", "color=blue&color=black&color=brown"},
		{StyleForm, true, "object", "R=100&G=200&B=150"},
		{StyleSpaceDelimited, false, "array", "color=blue%20black%20brown"},
		{StyleSpaceDelimited, false, "object", "color=R%20100%20G%20200%20B%20150"},
		{StylePipeDelimited, false, "array", "color=blue|black|brown"},
		{StylePipeDelimited, false, "object", "color=R|100|G|200|B|150"},
		{StyleDeepObject, true, "object", "color[R]=100&color[G]=200&color[B]=150"},
	}
	for _, c := range cases {
		spec := ParamSpec{Name: "color", In: InQuery, Style: c.style, Explode: c.explode}
		got := serializeQuery([]ParamSpec{spec}, NewValues().Query("color", colorValue(c.kind)))
		if got != c.want {
			t.Errorf("style %d explode=%v %s: got %q, want %q", c.style, c.explode, c.kind, got, c.want)
		}
	}
}

func TestPercentEncodesReservedCharsInPathValues(t *testing.T) {
	spec := []ParamSpec{{Name: "name", In: InPath, Style: StyleSimple}}
	for value, want := range map[string]string{"a/b?c#d e": "/files/a%2Fb%3Fc%23d%20e", "日本": "/files/%E6%97%A5%E6%9C%AC"} {
		got, err := serializePath("/files/{name}", spec, NewValues().Path("name", value))
		if err != nil || got != want {
			t.Errorf("%q: got %q (%v), want %q", value, got, err, want)
		}
	}
}

func TestAllowReservedKeepsReservedCharsInQueryOnly(t *testing.T) {
	query := ParamSpec{Name: "reserved", In: InQuery, Style: StyleForm, Explode: true, AllowReserved: true}
	if got := serializeQuery([]ParamSpec{query}, NewValues().Query("reserved", "a/b?c:d")); got != "reserved=a/b?c:d" {
		t.Errorf("query: got %q", got)
	}
	path := ParamSpec{Name: "name", In: InPath, Style: StyleSimple, AllowReserved: true}
	if got, _ := serializePath("/files/{name}", []ParamSpec{path}, NewValues().Path("name", "a/b")); got != "/files/a%2Fb" {
		t.Errorf("path: got %q", got)
	}
}

func TestKeepsEncodeURIComponentSafeChars(t *testing.T) {
	spec := ParamSpec{Name: "q", In: InQuery, Style: StyleForm, Explode: true}
	if got := serializeQuery([]ParamSpec{spec}, NewValues().Query("q", "!'()*~-_.")); got != "q=!'()*~-_." {
		t.Errorf("got %q", got)
	}
}

func TestSkipsNilValues(t *testing.T) {
	var specs []ParamSpec
	for _, name := range []string{"a", "b", "c"} {
		specs = append(specs, ParamSpec{Name: name, In: InQuery, Style: StyleForm, Explode: true})
	}
	x := "x"
	values := NewValues().Query("a", (*int)(nil)).Query("b", []string(nil)).Query("c", []*string{&x, nil})
	if got := serializeQuery(specs, values); got != "c=x" {
		t.Errorf("got %q", got)
	}
}

func TestSerializesNumbersAndBooleansAsLiterals(t *testing.T) {
	var specs []ParamSpec
	for _, name := range []string{"n", "f", "b", "l"} {
		specs = append(specs, ParamSpec{Name: name, In: InQuery, Style: StyleForm, Explode: true})
	}
	values := NewValues().Query("n", 42).Query("f", 1.5).Query("b", true).Query("l", int64(math.MaxInt64))
	if got := serializeQuery(specs, values); got != "n=42&f=1.5&b=true&l=9223372036854775807" {
		t.Errorf("got %q", got)
	}
}

// JavaScript's String(number): shortest round-trip digits, no ".0", exponent form outside 1e-7 < |x| < 1e21.
func TestSerializesFloatsLikeJavaScript(t *testing.T) {
	tenth, fifth := 0.1, 0.2
	cases := []struct {
		value float64
		want  string
	}{
		{2.0, "2"},
		{1e10, "10000000000"},
		{1.5, "1.5"},
		{-2.5, "-2.5"},
		{1e21, "1e+21"},
		{1.5e21, "1.5e+21"},
		{123456789012345680000.0, "123456789012345680000"},
		{1e-7, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{0.000001, "0.000001"},
		{tenth + fifth, "0.30000000000000004"},
		{5e-324, "5e-324"},
		{math.MaxFloat64, "1.7976931348623157e+308"},
		{math.Copysign(0, -1), "0"},
		{0, "0"},
	}
	query := ParamSpec{Name: "n", In: InQuery, Style: StyleForm, Explode: true}
	header := ParamSpec{Name: "n", In: InHeader, Style: StyleSimple}
	for _, c := range cases {
		if got := serializeQuery([]ParamSpec{query}, NewValues().Query("n", c.value)); got != "n="+strings.ReplaceAll(c.want, "+", "%2B") {
			t.Errorf("%v (query): got %q, want %q", c.value, got, c.want)
		}
		value, _ := toJSONValue(c.value)
		if got, _, _ := serializeHeader(header, value); got != c.want {
			t.Errorf("%v (header): got %q, want %q", c.value, got, c.want)
		}
	}
	// Literals written by hand (json.RawMessage) are normalized too.
	if got := jsNumber("1.0"); got != "1" {
		t.Errorf("1.0: got %q", got)
	}
}

func TestSerializeCookieJoinsWithSemicolonSpace(t *testing.T) {
	specs := []ParamSpec{
		{Name: "theme", In: InCookie, Style: StyleForm, Explode: true},
		{Name: "tags", In: InCookie, Style: StyleForm},
	}
	values := NewValues().Cookie("theme", "dark").Cookie("tags", []string{"x", "y"})
	if got := serializeCookie(specs, values); got != "theme=dark; tags=x,y" {
		t.Errorf("got %q", got)
	}
	if got := serializeCookie(specs, NewValues()); got != "" {
		t.Errorf("empty: got %q", got)
	}
}

func TestSerializesHeaderWithoutEncoding(t *testing.T) {
	spec := ParamSpec{Name: "X-Ids", In: InHeader, Style: StyleSimple}
	value, _ := toJSONValue([]string{"a b", "c/d"})
	if got, ok, err := serializeHeader(spec, value); got != "a b,c/d" || !ok || err != nil {
		t.Errorf("got %q %v %v", got, ok, err)
	}
}

func TestRejectsInvalidValues(t *testing.T) {
	spec := []ParamSpec{{Name: "id", In: InPath, Style: StyleSimple}}
	for _, value := range []string{".", "..", ""} {
		if _, err := serializePath("/a/{id}", spec, NewValues().Path("id", value)); err == nil {
			t.Errorf("%q: expected an error", value)
		}
	}
	if _, err := serializePath("/a/{id}", spec, NewValues()); err == nil {
		t.Error("missing path parameter: expected an error")
	}
	header := ParamSpec{Name: "X-A", In: InHeader, Style: StyleSimple}
	value, _ := toJSONValue([]string{"a\r\nb"})
	if _, _, err := serializeHeader(header, value); err == nil {
		t.Error("CR LF in a header: expected an error")
	}
	if err := NewValues().Query("bad", math.NaN()).err; err == nil {
		t.Error("NaN: expected an encoding error")
	}
}

func TestFormEncodingMatchesURLSearchParams(t *testing.T) {
	for in, want := range map[string]string{"a b&c": "a+b%26c", "*-._~!'": "*-._%7E%21%27", "日": "%E6%97%A5"} {
		if got := encodeForm(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestEncodesUTF8AndInvalidBytes(t *testing.T) {
	if got := encodeComponent("😀"); got != "%F0%9F%98%80" {
		t.Errorf("emoji: got %q", got)
	}
	if got := encodeComponent("a\xffb"); got != "a%EF%BF%BDb" {
		t.Errorf("invalid UTF-8: got %q", got)
	}
}

func TestKeepsObjectMemberOrderAndNestsDeepObjects(t *testing.T) {
	spec := ParamSpec{Name: "filter", In: InQuery, Style: StyleDeepObject, Explode: true}
	value := map[string]any{"z": 1} // a single key, so map ordering cannot matter
	if got := serializeQuery([]ParamSpec{spec}, NewValues().Query("filter", value)); got != "filter[z]=1" {
		t.Errorf("map: got %q", got)
	}
	type nested struct {
		Status string `json:"status"`
		Range  struct {
			Min int `json:"min"`
			Max int `json:"max"`
		} `json:"range"`
		Tags []string `json:"tags"`
	}
	n := nested{Status: "active", Tags: []string{"a", "b"}}
	n.Range.Min, n.Range.Max = 1, 9
	got := serializeQuery([]ParamSpec{spec}, NewValues().Query("filter", n))
	if want := "filter[status]=active&filter[range][min]=1&filter[range][max]=9&filter[tags]=a&filter[tags]=b"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestErrorBodyMatchesTheDeclaredType(t *testing.T) {
	type notFound struct{ Resource string }
	err := error(&APIError{StatusCode: 404, Body: &notFound{Resource: "x"}})
	if body, ok := ErrorBody[*notFound](err); !ok || body.Resource != "x" {
		t.Errorf("got %v %v", body, ok)
	}
	if _, ok := ErrorBody[*rgb](err); ok {
		t.Error("another type must not match")
	}
	if _, ok := ErrorBody[*notFound](errors.New("x")); ok {
		t.Error("a non-API error must not match")
	}
}
