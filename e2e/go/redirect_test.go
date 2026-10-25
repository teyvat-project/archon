package e2e

import (
	"net/url"
	"testing"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func TestDropsCredentialsWhenARedirectCrossesOrigins(t *testing.T) {
	client := newClient(withAuth(&edgecases.Auth{ApiKeyHeader: core.StaticToken("test-key")}), func(o *edgecases.ClientOptions) {
		o.Headers = map[string]string{"Authorization": "Bearer test-token"}
	})
	echo, resp, err := client.Middleware.RedirectCrossOrigin(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 200)
	secondary, _ := url.Parse(secondaryURL)
	equal(t, resp.Request.URL.Scheme+"://"+resp.Request.URL.Host, secondary.Scheme+"://"+secondary.Host)
	equal(t, echo.Path, "/echo/headers")
	for _, name := range []string{"x-api-key", "authorization"} {
		if _, ok := echo.Headers[name]; ok {
			t.Errorf("%s reached the other origin", name)
		}
	}
}
