package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"

	"archon.e2e/edgecases"
)

var (
	baseURL      string
	secondaryURL string
	// One transport for every test; each SDK client derives its own configuration from it.
	httpClient = &http.Client{}
	ctx        = context.Background()
)

func TestMain(m *testing.M) {
	baseURL = os.Getenv("ARCHON_E2E_BASE_URL")
	secondaryURL = os.Getenv("ARCHON_E2E_SECONDARY_URL")
	if baseURL == "" || secondaryURL == "" {
		fmt.Fprintln(os.Stderr, "ARCHON_E2E_BASE_URL / ARCHON_E2E_SECONDARY_URL are not set; run the suite with `pnpm test:e2e:go`.")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// newClient returns a client for the mock server, after configure has adjusted its options.
func newClient(configure ...func(*edgecases.ClientOptions)) *edgecases.Client {
	options := edgecases.ClientOptions{BaseURL: baseURL, HTTPClient: httpClient}
	for _, f := range configure {
		f(&options)
	}
	return edgecases.NewClient(options)
}

// stats are the mock server's counters: tokens issued and requests per raw path.
type stats struct {
	TokensIssued int            `json:"tokensIssued"`
	Requests     map[string]int `json:"requests"`
}

func getStats(t *testing.T) stats {
	t.Helper()
	resp, err := httpClient.Get(baseURL + "/__stats")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var s stats
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func noError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func equal[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("got %v, want %v", got, want)
	}
}
