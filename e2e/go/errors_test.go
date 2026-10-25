package e2e

import (
	"errors"
	"testing"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func TestReturnsTheSuccessBodyFor200(t *testing.T) {
	data, _, err := newClient().Errors.GetError(ctx, edgecases.GetErrorParams{Status: 200})
	noError(t, err)
	equal(t, data.Ok, true)
}

func TestReturnsATypedErrorBodyFor404(t *testing.T) {
	_, _, err := newClient().Errors.GetError(ctx, edgecases.GetErrorParams{Status: 404})
	var apiErr *core.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("got %v", err)
	}
	equal(t, apiErr.StatusCode, 404)
	body, ok := core.ErrorBody[*edgecases.NotFoundError](err)
	if !ok {
		t.Fatalf("body %#v", apiErr.Body)
	}
	equal(t, body.Message+" "+body.Resource, "Not found errors/404")
}

func TestReturnsThe400ValidationErrorBody(t *testing.T) {
	_, _, err := newClient().Errors.GetError(ctx, edgecases.GetErrorParams{Status: 400})
	body, ok := core.ErrorBody[*edgecases.ValidationError](err)
	if !ok {
		t.Fatalf("got %v", err)
	}
	equal(t, body.Message, "Validation failed")
	equal(t, len(body.Fields), 1)
	equal(t, body.Fields[0].Name+" "+body.Fields[0].Reason, "status invalid")
}

func TestReturnsTheDefaultErrorBodyForAnyOtherStatus(t *testing.T) {
	for _, status := range []int{418, 500} {
		_, resp, err := newClient().Errors.GetError(ctx, edgecases.GetErrorParams{Status: status})
		body, ok := core.ErrorBody[*edgecases.Error](err)
		if !ok {
			t.Fatalf("%d: got %v", status, err)
		}
		equal(t, resp.StatusCode, status)
		equal(t, body.Code, status)
	}
}
