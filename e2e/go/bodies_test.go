package e2e

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"archon.e2e/edgecases"
	"archon.e2e/edgecases/core"
)

func TestSendsAJSONBody(t *testing.T) {
	payload := edgecases.JsonPayload{Name: "archon", Count: 3, Tags: []string{"a", "b"}, Nested: &edgecases.Nested{Flag: core.Ptr(true)}}
	echo, _, err := newClient().Echo.EchoJson(ctx, payload)
	noError(t, err)
	equal(t, echo.Method, "POST")
	equal(t, *echo.ContentType, "application/json")
	var sent edgecases.JsonPayload
	noError(t, json.Unmarshal([]byte(*echo.Body), &sent))
	if !reflect.DeepEqual(sent, payload) {
		t.Errorf("sent %+v, want %+v", sent, payload)
	}
	// Optional nils are not written (the "unset" vs "null" distinction is out of scope).
	if strings.Contains(*echo.Body, "note") {
		t.Errorf("body %s", *echo.Body)
	}
}

func TestSendsAURLEncodedFormBodyWithRepeatedArrayFields(t *testing.T) {
	echo, _, err := newClient().Echo.EchoForm(ctx, edgecases.EchoFormBody{Name: "a b&c", Count: core.Ptr(2), Tags: []string{"x", "y"}})
	noError(t, err)
	equal(t, *echo.ContentType, "application/x-www-form-urlencoded")
	equal(t, *echo.Body, "name=a+b%26c&count=2&tags=x&tags=y")
}

func TestSendsAMultipartBodyWithFileNamesAndSizes(t *testing.T) {
	echo, _, err := newClient().Echo.EchoMultipart(ctx, edgecases.EchoMultipartBody{
		Title:       "hello",
		File:        core.File{Content: make([]byte, 10), Name: "data.bin", ContentType: "application/octet-stream"},
		Attachments: []core.File{{Content: []byte("abc"), Name: "a.txt"}, {Content: []byte("hello"), Name: "b.txt"}},
	})
	noError(t, err)
	if !strings.HasPrefix(*echo.ContentType, "multipart/form-data; boundary=") {
		t.Errorf("content type %s", *echo.ContentType)
	}
	equal(t, *echo.Body, `{"title":"hello"}`)
	var files []string
	for _, f := range echo.Files {
		files = append(files, fmt.Sprintf("%s %s %d", f.Field, f.Name, f.Size))
	}
	equal(t, strings.Join(files, "; "), "file data.bin 10; attachments a.txt 3; attachments b.txt 5")
}

func TestSendsABinaryBody(t *testing.T) {
	echo, _, err := newClient().Echo.EchoBinary(ctx, core.File{Content: []byte("raw bytes")})
	noError(t, err)
	equal(t, *echo.ContentType, "application/octet-stream")
	equal(t, echo.Headers["content-length"], "9")
	equal(t, *echo.Body, "raw bytes")
}

func TestSendsAPlainTextBody(t *testing.T) {
	echo, _, err := newClient().Echo.EchoText(ctx, "hello, text")
	noError(t, err)
	equal(t, *echo.ContentType, "text/plain")
	equal(t, *echo.Body, "hello, text")
}

func TestRoundTripsARecursiveAllOfTreeTheServerAssigningIDs(t *testing.T) {
	root, resp, err := newClient().Nodes.CreateNode(ctx, edgecases.Node{
		Id:     "placeholder",
		Name:   "root",
		Labels: map[string]string{"env": "test"},
		Children: []edgecases.Node{
			{Id: "placeholder", Name: "a", Children: []edgecases.Node{{Id: "placeholder", Name: "a1", Children: []edgecases.Node{}}}},
			{Id: "placeholder", Name: "b", Children: []edgecases.Node{}},
		},
	})
	noError(t, err)
	equal(t, resp.StatusCode, 201)
	equal(t, root.Id, "n1")
	if root.ParentId != nil {
		t.Errorf("root parent %v", *root.ParentId)
	}
	equal(t, root.Name, "root")
	equal(t, root.Labels["env"], "test")
	equal(t, len(root.Children), 2)
	equal(t, root.Children[0].Id+","+root.Children[1].Id, "n2,n4")
	for _, child := range root.Children {
		equal(t, *child.ParentId, "n1")
	}
	a1 := root.Children[0].Children[0]
	equal(t, a1.Id+" "+*a1.ParentId+" "+a1.Name, "n3 n2 a1")
	equal(t, len(root.Children[1].Children), 0)
}
