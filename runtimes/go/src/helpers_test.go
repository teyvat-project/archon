package core

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// recorded is a request as the test server received it.
type recorded struct {
	Method     string
	RequestURI string
	Host       string
	Header     http.Header
	Body       []byte
}

// testServer records every request and answers with handle (200 with an empty JSON object by default).
type testServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recorded
	handle   func(w http.ResponseWriter, r *http.Request, body []byte)
}

func newTestServer(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *testServer {
	t.Helper()
	s := &testServer{handle: handle}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.requests = append(s.requests, recorded{r.Method, r.RequestURI, r.Host, r.Header.Clone(), body})
		s.mu.Unlock()
		if s.handle == nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{}"))
			return
		}
		s.handle(w, r, body)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *testServer) received() []recorded {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recorded(nil), s.requests...)
}

func (s *testServer) last(t *testing.T) recorded {
	t.Helper()
	requests := s.received()
	if len(requests) == 0 {
		t.Fatal("the server received no request")
	}
	return requests[len(requests)-1]
}

func reply(status int, contentType, body string) func(http.ResponseWriter, *http.Request, []byte) {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func getOp(path string, params ...ParamSpec) *OperationSpec {
	return &OperationSpec{Name: "test", Method: http.MethodGet, Path: path, Params: params, Responses: map[string]ResponseKind{"200": ResponseJSON}}
}

type testAuth map[string]any

func (a testAuth) Get(scheme string) any { return a[scheme] }
