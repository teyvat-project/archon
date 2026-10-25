package e2e

import (
	"strings"
	"testing"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func TestSerializesAllPathStyles(t *testing.T) {
	echo, _, err := newClient().Echo.EchoPathStyles(ctx, edgecases.EchoPathStylesParams{
		Simple: []string{"a", "b"},
		Label:  []string{"a", "b"},
		Matrix: edgecases.EchoPathStylesMatrix{X: 1, Y: 2},
	})
	noError(t, err)
	equal(t, echo.Method, "GET")
	equal(t, echo.Path, "/echo/path/a,b/.a.b/;x=1;y=2")
	equal(t, echo.Query, "")
}

func TestPercentEncodesReservedCharacters(t *testing.T) {
	echo, _, err := newClient().Echo.EchoPathStyles(ctx, edgecases.EchoPathStylesParams{
		Simple: []string{"a/b?c#d e", "日本"},
		Label:  []string{"x"},
		Matrix: edgecases.EchoPathStylesMatrix{X: 1, Y: 2},
	})
	noError(t, err)
	equal(t, echo.Path, "/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2")
}

func TestSerializesAllQueryStyles(t *testing.T) {
	echo, _, err := newClient().Echo.EchoQueryStyles(ctx, edgecases.EchoQueryStylesParams{
		FormExploded: []string{"a", "b"},
		FormFlat:     []string{"a", "b"},
		Spaced:       []string{"a", "b"},
		Piped:        []int{1, 2},
		Filter:       &edgecases.EchoQueryStylesFilter{Status: core.Ptr("active"), MinAge: core.Ptr(3)},
		Reserved:     core.Ptr("a/b?c:d"),
		Limit:        core.Ptr(10),
	})
	noError(t, err)
	equal(t, echo.Path, "/echo/query")
	equal(t, echo.Query, strings.Join([]string{
		"formExploded=a&formExploded=b",
		"formFlat=a,b",
		"spaced=a%20b",
		"piped=1|2",
		"filter[status]=active&filter[minAge]=3",
		"reserved=a/b?c:d",
		"limit=10",
	}, "&"))
}

func TestOmitsUnsetQueryParameters(t *testing.T) {
	echo, _, err := newClient().Echo.EchoQueryStyles(ctx, edgecases.EchoQueryStylesParams{Limit: core.Ptr(1)})
	noError(t, err)
	equal(t, echo.Query, "limit=1")
}

func TestSendsHeaderArrayAndCookies(t *testing.T) {
	echo, _, err := newClient().Echo.EchoHeadersCookies(ctx, edgecases.EchoHeadersCookiesParams{
		XRequestIds: []string{"a", "b"},
		XTrace:      core.Ptr("trace-1"),
		Theme:       "dark",
		Tags:        []string{"x", "y"},
	})
	noError(t, err)
	equal(t, echo.Headers["x-request-ids"], "a,b")
	equal(t, echo.Headers["x-trace"], "trace-1")
	equal(t, echo.Headers["cookie"], "theme=dark; tags=x,y")
	equal(t, len(echo.Cookies), 2)
	equal(t, echo.Cookies["theme"], "dark")
	equal(t, echo.Cookies["tags"], "x,y")
}
