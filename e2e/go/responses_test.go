package e2e

import (
	"io"
	"testing"
)

func TestDecodesTextPlainAsAString(t *testing.T) {
	text, _, err := newClient().Responses.GetText(ctx)
	noError(t, err)
	equal(t, text, "hello, archon")
}

func TestDecodesOctetStreamAsBytes(t *testing.T) {
	data, _, err := newClient().Responses.GetBinary(ctx)
	noError(t, err)
	equal(t, len(data), 256)
	equal(t, data[0], 0x00)
	equal(t, data[255], 0xff)
}

func TestReturnsWithoutDataFor204NoContent(t *testing.T) {
	resp, err := newClient().Responses.GetEmpty(ctx)
	noError(t, err)
	equal(t, resp.StatusCode, 204)
}

// Like C#, the declared type can be nil, so an empty body declared as JSON decodes to nil.
func TestReturnsNilForAnEmptyBodyDeclaredAsJSON(t *testing.T) {
	data, resp, err := newClient().Responses.GetEmptyJson(ctx)
	noError(t, err)
	if data != nil {
		t.Errorf("got %+v", data)
	}
	equal(t, resp.StatusCode, 200)
	body, _ := io.ReadAll(resp.Body)
	equal(t, len(body), 0)
}
