package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

type pet struct {
	Name string `json:"name"`
}

type notFound struct {
	Message string `json:"message"`
}

func TestBuildsURLPreservingBaseURLPath(t *testing.T) {
	s := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL + "/api/"}, nil)
	op := getOp("/foo/{id}", ParamSpec{Name: "id", In: InPath, Style: StyleSimple})
	if _, _, err := Do(context.Background(), c, op, NewValues().Path("id", 1), DecodeJSON[map[string]any], nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t); got.Method != "GET" || got.RequestURI != "/api/foo/1" {
		t.Errorf("got %s %s", got.Method, got.RequestURI)
	}
}

func TestSendsPipesBracketsAndEscapesUnchanged(t *testing.T) {
	s := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL + "?x=%41"}, nil)
	op := getOp("/files/{name}",
		ParamSpec{Name: "name", In: InPath, Style: StyleSimple},
		ParamSpec{Name: "piped", In: InQuery, Style: StylePipeDelimited},
		ParamSpec{Name: "filter", In: InQuery, Style: StyleDeepObject, Explode: true},
	)
	values := NewValues().Path("name", "a/b").Query("piped", []int{1, 2}).Query("filter", map[string]string{"a": "b"})
	if _, _, err := Do(context.Background(), c, op, values, DecodeJSON[map[string]any], nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t).RequestURI; got != "/files/a%2Fb?x=%41&piped=1|2&filter[a]=b" {
		t.Errorf("got %s", got)
	}
}

func TestDecodesSuccessAndErrorBodies(t *testing.T) {
	s := newTestServer(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		switch r.URL.Path {
		case "/ok":
			reply(200, "application/json", `{"name":"Tama"}`)(w, r, nil)
		case "/missing":
			reply(404, "application/json", `{"message":"no such pet"}`)(w, r, nil)
		case "/html":
			reply(500, "text/html", `<h1>oops</h1>`)(w, r, nil)
		case "/empty":
			w.WriteHeader(204)
		case "/invalid":
			reply(200, "application/json", `{"name":`)(w, r, nil)
		}
	})
	c := NewClient(Options{BaseURL: s.URL}, nil)
	errs := ErrorDecoders{"404": JSONError[notFound], "default": JSONError[notFound]}

	data, resp, err := Do(context.Background(), c, getOp("/ok"), nil, DecodeJSON[*pet], errs, nil)
	if err != nil || data.Name != "Tama" || resp.StatusCode != 200 {
		t.Fatalf("ok: %v %v %v", data, resp, err)
	}
	if body, _ := io.ReadAll(resp.Body); string(body) != `{"name":"Tama"}` {
		t.Errorf("the returned response body is %q", body)
	}

	_, resp, err = Do(context.Background(), c, getOp("/missing"), nil, DecodeJSON[*pet], errs, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 || resp.StatusCode != 404 {
		t.Fatalf("missing: %v", err)
	}
	if body, ok := ErrorBody[*notFound](err); !ok || body.Message != "no such pet" {
		t.Errorf("missing: body %v", apiErr.Body)
	}

	_, _, err = Do(context.Background(), c, getOp("/html"), nil, DecodeJSON[*pet], errs, nil)
	if !errors.As(err, &apiErr) || apiErr.Body != nil || string(apiErr.RawBody) != "<h1>oops</h1>" || apiErr.Err == nil {
		t.Errorf("html: %#v", err)
	}

	if data, _, err := Do(context.Background(), c, getOp("/empty"), nil, DecodeJSON[*pet], errs, nil); err != nil || data != nil {
		t.Errorf("204 into a pointer: %v %v", data, err)
	}
	var decodeErr *DecodeError
	if _, _, err := Do(context.Background(), c, getOp("/empty"), nil, DecodeJSON[int], errs, nil); !errors.As(err, &decodeErr) || decodeErr.StatusCode != 204 {
		t.Errorf("204 into an int: %v", err)
	}
	if _, _, err := Do(context.Background(), c, getOp("/invalid"), nil, DecodeJSON[*pet], errs, nil); !errors.As(err, &decodeErr) || string(decodeErr.RawBody) != `{"name":` {
		t.Errorf("invalid JSON: %v", err)
	}
}

func TestTransportErrors(t *testing.T) {
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := listener.Addr().String()
	_ = listener.Close()
	c := NewClient(Options{BaseURL: "http://" + addr}, nil)
	var transportErr *TransportError
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, nil); !errors.As(err, &transportErr) || transportErr.Timeout {
		t.Errorf("connection refused: %v", err)
	}

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	slow := newTestServer(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})

	c = NewClient(Options{BaseURL: slow.URL, Timeout: 50 * time.Millisecond}, nil)
	if _, _, err := Do(context.Background(), c, getOp("/slow"), nil, DecodeNone, nil, nil); !errors.As(err, &transportErr) || !transportErr.Timeout {
		t.Errorf("timeout: %v", err)
	}

	c = NewClient(Options{BaseURL: slow.URL}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	_, _, err := Do(ctx, c, getOp("/slow"), nil, DecodeNone, nil, nil)
	if !errors.As(err, &transportErr) || transportErr.Timeout || !errors.Is(err, context.Canceled) {
		t.Errorf("cancellation: %v", err)
	}
}

func TestTimeoutStopsWhenTheHeadersArrive(t *testing.T) {
	s := newTestServer(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(150 * time.Millisecond)
		_, _ = w.Write([]byte("late body"))
	})
	c := NewClient(Options{BaseURL: s.URL, Timeout: 50 * time.Millisecond}, nil)
	op := getOp("/x")
	op.Responses = map[string]ResponseKind{"200": ResponseText}
	if text, _, err := Do(context.Background(), c, op, nil, DecodeText, nil, nil); err != nil || text != "late body" {
		t.Errorf("got %q %v", text, err)
	}
}

func TestRunsMiddlewareOuterToInnerWithAuthInnermost(t *testing.T) {
	s := newTestServer(t, nil)
	var order []string
	tag := func(name string) Middleware {
		return func(req *Request, next Next, ctx *CallContext) (*Response, error) {
			order = append(order, name+":before")
			resp, err := next(req)
			order = append(order, name+":after")
			return resp, err
		}
	}
	token := TokenFunc(func(context.Context) (string, error) {
		order = append(order, "auth")
		return "t", nil
	})
	c := NewClient(Options{BaseURL: s.URL, Middleware: []Middleware{tag("mw1")}, Auth: testAuth{"bearer": token}},
		map[string]SecuritySchemeSpec{"bearer": {Kind: SchemeHTTPBearer}})
	c.Use(tag("mw2"))
	op := getOp("/x")
	op.Security = []SecurityRequirement{{{Name: "bearer"}}}
	if _, _, err := Do(context.Background(), c, op, nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	want := "mw1:before mw2:before auth mw2:after mw1:after"
	if got := strings.Join(order, " "); got != want {
		t.Errorf("got %s", got)
	}
	if got := s.last(t).Header.Get("Authorization"); got != "Bearer t" {
		t.Errorf("authorization %q", got)
	}
}

func TestEncodesBodies(t *testing.T) {
	s := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL}, nil)
	post := func(kind BodyKind, mediaType string, values *Values) recorded {
		t.Helper()
		op := &OperationSpec{Name: "post", Method: http.MethodPost, Path: "/body", Body: kind, MediaType: mediaType}
		if _, _, err := Do(context.Background(), c, op, values, DecodeNone, nil, nil); err != nil {
			t.Fatal(err)
		}
		return s.last(t)
	}

	got := post(BodyJSON, "application/merge-patch+json", NewValues().JSONBody(map[string]string{"a": "<b>"}))
	if got.Header.Get("Content-Type") != "application/merge-patch+json" || string(got.Body) != `{"a":"<b>"}` || got.Header.Get("Accept") != "*/*" {
		t.Errorf("json: %v %s", got.Header, got.Body)
	}

	type form struct {
		Name  string   `json:"name"`
		Count int      `json:"count"`
		Tags  []string `json:"tags"`
		Note  *string  `json:"note,omitempty"`
	}
	got = post(BodyForm, "application/x-www-form-urlencoded", NewValues().FormBody(form{Name: "a b&c", Count: 2, Tags: []string{"x", "y"}}))
	if string(got.Body) != "name=a+b%26c&count=2&tags=x&tags=y" || got.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Errorf("form: %s", got.Body)
	}

	got = post(BodyText, "text/plain", NewValues().TextBody("hello"))
	if string(got.Body) != "hello" || got.Header.Get("Content-Type") != "text/plain" {
		t.Errorf("text: %s", got.Body)
	}

	got = post(BodyBinary, "", NewValues().BinaryBody(File{Content: []byte("raw"), ContentType: "image/png"}))
	if string(got.Body) != "raw" || got.Header.Get("Content-Type") != "image/png" || got.Header.Get("Content-Length") != "3" {
		t.Errorf("binary: %v %s", got.Header, got.Body)
	}

	multipart := NewMultipart().Field("title", "hello").Field("n", []int{1, 2}).File("file", &File{Content: []byte("abc"), Name: `a"b.txt`}).Files("more", []File{{Content: []byte("x")}})
	first := post(BodyMultipart, "multipart/form-data", NewValues().Body(multipart))
	second := post(BodyMultipart, "multipart/form-data", NewValues().Body(multipart))
	if !bytes.Equal(first.Body, second.Body) {
		t.Error("a multipart body must produce the same bytes on every send")
	}
	boundary := strings.TrimPrefix(first.Header.Get("Content-Type"), "multipart/form-data; boundary=")
	want := strings.Join([]string{
		"--" + boundary, `Content-Disposition: form-data; name="title"`, "", "hello",
		"--" + boundary, `Content-Disposition: form-data; name="n"`, "", "1",
		"--" + boundary, `Content-Disposition: form-data; name="n"`, "", "2",
		"--" + boundary, `Content-Disposition: form-data; name="file"; filename="a%22b.txt"`, "Content-Type: application/octet-stream", "", "abc",
		"--" + boundary, `Content-Disposition: form-data; name="more"; filename="blob"`, "Content-Type: application/octet-stream", "", "x",
		"--" + boundary + "--", "",
	}, "\r\n")
	if string(first.Body) != want {
		t.Errorf("multipart:\n%q\nwant\n%q", first.Body, want)
	}
}

func TestFileAndDateJSON(t *testing.T) {
	data, _ := json.Marshal(struct {
		F File `json:"f"`
		D Date `json:"d"`
	}{File{Content: []byte("hi")}, Date{2000, time.January, 2}})
	if string(data) != `{"f":"aGk=","d":"2000-01-02"}` {
		t.Errorf("got %s", data)
	}
	var back struct {
		F File `json:"f"`
		D Date `json:"d"`
	}
	if err := json.Unmarshal(data, &back); err != nil || string(back.F.Content) != "hi" || back.D.String() != "2000-01-02" {
		t.Errorf("got %v %v", back, err)
	}
	if err := json.Unmarshal([]byte(`{"d":"2000-13-40"}`), &back); err == nil {
		t.Error("an invalid date must fail")
	}
}

func TestRedirects(t *testing.T) {
	other := newTestServer(t, nil)
	var s *testServer
	s = newTestServer(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		switch r.URL.Path {
		case "/cross":
			http.Redirect(w, r, other.URL+"/landing?api_key=k&keep=1", http.StatusFound)
		case "/same":
			http.Redirect(w, r, "/landing", http.StatusTemporaryRedirect)
		case "/see-other":
			http.Redirect(w, r, "/landing", http.StatusSeeOther)
		default:
			reply(200, "application/json", "{}")(w, r, nil)
		}
	})
	schemes := map[string]SecuritySchemeSpec{
		"header": {Kind: SchemeAPIKey, In: APIKeyInHeader, Name: "X-API-Key"},
		"query":  {Kind: SchemeAPIKey, In: APIKeyInQuery, Name: "api_key"},
	}
	// A client that would follow redirects (and keep headers) on its own.
	followAll := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return nil }}
	c := NewClient(Options{BaseURL: s.URL, HTTPClient: followAll, Headers: map[string]string{"Authorization": "Bearer t", "Cookie": "a=1"}, Auth: testAuth{"header": StaticToken("k")}}, schemes)
	op := getOp("/cross")
	op.Security = []SecurityRequirement{{{Name: "header"}}}

	_, resp, err := Do(context.Background(), c, op, nil, DecodeNone, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := other.last(t)
	if got.RequestURI != "/landing?keep=1" || got.Header.Get("X-API-Key") != "" || got.Header.Get("Authorization") != "" || got.Header.Get("Cookie") != "" {
		t.Errorf("cross-origin: %s %v", got.RequestURI, got.Header)
	}
	if resp.Request.URL.String() != other.URL+"/landing?keep=1" {
		t.Errorf("final URL %s", resp.Request.URL)
	}

	if _, _, err := Do(context.Background(), c, getOp("/same"), nil, DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t); got.RequestURI != "/landing" || got.Header.Get("Authorization") != "Bearer t" {
		t.Errorf("same-origin: %s %v", got.RequestURI, got.Header)
	}

	post := &OperationSpec{Name: "post", Method: http.MethodPost, Path: "/see-other", Body: BodyText, MediaType: "text/plain"}
	if _, _, err := Do(context.Background(), c, post, NewValues().TextBody("x"), DecodeNone, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.last(t); got.Method != "GET" || len(got.Body) != 0 || got.Header.Get("Content-Type") != "" {
		t.Errorf("303: %s %v %q", got.Method, got.Header, got.Body)
	}

	// A streamed body cannot be sent again, so the redirect is returned as is.
	stream := &OperationSpec{Name: "put", Method: http.MethodPut, Path: "/same", Body: BodyBinary, Responses: map[string]ResponseKind{"200": ResponseEmpty}}
	_, _, err = Do(context.Background(), c, stream, NewValues().Body(NewReaderBody(strings.NewReader("once"), "")), DecodeNone, nil, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusTemporaryRedirect {
		t.Errorf("stream: %v", err)
	}
}

func TestRequestOptionsAndUse(t *testing.T) {
	s := newTestServer(t, nil)
	other := newTestServer(t, nil)
	c := NewClient(Options{BaseURL: s.URL, Headers: map[string]string{"X-A": "client"}}, nil)
	var seen any
	c.Use(func(req *Request, next Next, ctx *CallContext) (*Response, error) {
		seen = ctx.Extensions["k"]
		return next(req)
	})
	opts := []RequestOption{WithHeader("x-a", "call"), WithBaseURL(other.URL), WithExtension("k", 42)}
	if _, _, err := Do(context.Background(), c, getOp("/x"), nil, DecodeNone, nil, opts); err != nil {
		t.Fatal(err)
	}
	if got := other.last(t).Header.Get("X-A"); got != "call" || seen != 42 || len(s.received()) != 0 {
		t.Errorf("got %q %v", got, seen)
	}
	if _, _, err := Do(context.Background(), NewClient(Options{BaseURL: "/relative"}, nil), getOp("/x"), nil, DecodeNone, nil, nil); err == nil {
		t.Error("a relative base URL must fail")
	}
}

func TestModelHelpers(t *testing.T) {
	if err := CheckRequired([]byte(`{"a":1,"b":null}`), "T", []string{"a"}, []string{"b"}); err != nil {
		t.Error(err)
	}
	for _, data := range []string{`{"b":null}`, `{"a":null,"b":1}`, `{"a":1}`} {
		if err := CheckRequired([]byte(data), "T", []string{"a"}, []string{"b"}); err == nil || !strings.HasPrefix(err.Error(), "T: ") {
			t.Errorf("%s: %v", data, err)
		}
	}
	if err := CheckRequired([]byte(`null`), "T", []string{"a"}, nil); err != nil {
		t.Error(err)
	}
	if Discriminator([]byte(` {"kind":"circle","r":1}`), "kind") != "circle" || Discriminator([]byte(`{"kind":1}`), "kind") != "" {
		t.Error("discriminator")
	}
	if v, ok := Try[int]([]byte(`1`)); !ok || *v != 1 {
		t.Error("Try int")
	}
	if _, ok := Try[int]([]byte(`"1"`)); ok {
		t.Error("Try int from a string")
	}
	if *Ptr("x") != "x" {
		t.Error("Ptr")
	}
}
