package core

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync/atomic"
)

// Body is a request body. Open is called once per send, so a replayable body can be sent again (redirects,
// retries); length is -1 when unknown.
type Body interface {
	Replayable() bool
	// ContentType is the Content-Type to send (copied into the request headers), or "" for none.
	ContentType() string
	Open() (r io.Reader, length int64, err error)
}

// BytesBody is a buffered body.
type BytesBody struct {
	content     []byte
	contentType string
}

// NewBytesBody returns a body of content.
func NewBytesBody(content []byte, contentType string) *BytesBody {
	return &BytesBody{content: content, contentType: contentType}
}

func (b *BytesBody) Replayable() bool    { return true }
func (b *BytesBody) ContentType() string { return b.contentType }

func (b *BytesBody) Open() (io.Reader, int64, error) {
	return bytes.NewReader(b.content), int64(len(b.content)), nil
}

// ReaderBody is a streamed body: sent once and never again (a redirect that needs the body again is returned as
// is, and retrying middleware does not re-send it).
type ReaderBody struct {
	reader      io.Reader
	contentType string
	used        atomic.Bool
}

// NewReaderBody returns a body that streams r.
func NewReaderBody(r io.Reader, contentType string) *ReaderBody {
	return &ReaderBody{reader: r, contentType: contentType}
}

func (b *ReaderBody) Replayable() bool    { return false }
func (b *ReaderBody) ContentType() string { return b.contentType }

func (b *ReaderBody) Open() (io.Reader, int64, error) {
	if !b.used.CompareAndSwap(false, true) {
		return nil, 0, errors.New("a ReaderBody can only be sent once")
	}
	return b.reader, -1, nil
}

// FormBody is an application/x-www-form-urlencoded body, encoded the way URLSearchParams does.
type FormBody struct {
	fields [][2]string
}

// NewFormBody returns an empty form.
func NewFormBody() *FormBody { return &FormBody{} }

// Add appends a field.
func (f *FormBody) Add(name, value string) *FormBody {
	f.fields = append(f.fields, [2]string{name, value})
	return f
}

func (f *FormBody) Replayable() bool    { return true }
func (f *FormBody) ContentType() string { return "application/x-www-form-urlencoded" }

func (f *FormBody) Open() (io.Reader, int64, error) {
	text := f.encode()
	return strings.NewReader(text), int64(len(text)), nil
}

func (f *FormBody) encode() string {
	pairs := make([]string, len(f.fields))
	for i, field := range f.fields {
		pairs[i] = encodeForm(field[0]) + "=" + encodeForm(field[1])
	}
	return strings.Join(pairs, "&")
}

// formFromJSON builds a form from a JSON object: arrays become repeated names, objects JSON text, nulls are
// skipped.
func formFromJSON(object jsonValue) *FormBody {
	form := NewFormBody()
	for i, value := range object.items {
		for _, text := range fieldValues(value) {
			form.Add(object.keys[i], text)
		}
	}
	return form
}

// fieldValues is a JSON value as form / multipart field values: arrays become one value per item, nulls are
// skipped, objects are JSON text.
func fieldValues(value jsonValue) []string {
	items := []jsonValue{value}
	if value.kind == jsonArray {
		items = value.items
	}
	var out []string
	for _, item := range items {
		if item.kind != jsonNull {
			out = append(out, item.scalarText())
		}
	}
	return out
}

// MultipartBody is a multipart/form-data body. The boundary is fixed per instance, so every send produces the
// same bytes.
type MultipartBody struct {
	parts    []multipartPart
	boundary string
	err      error
}

type multipartPart struct {
	name string
	text string
	file *File
}

// NewMultipart returns an empty multipart body.
func NewMultipart() *MultipartBody {
	random := make([]byte, 12)
	_, _ = rand.Read(random)
	return &MultipartBody{boundary: "archon-" + hex.EncodeToString(random)}
}

// Text adds a text part.
func (m *MultipartBody) Text(name, value string) *MultipartBody {
	m.parts = append(m.parts, multipartPart{name: name, text: value})
	return m
}

// Field adds text parts for a value: strings unquoted, numbers and booleans as written, arrays as repeated parts,
// objects as JSON text; nil adds nothing.
func (m *MultipartBody) Field(name string, value any) *MultipartBody {
	v, err := toJSONValue(value)
	if err != nil {
		if m.err == nil {
			m.err = err
		}
		return m
	}
	for _, text := range fieldValues(v) {
		m.Text(name, text)
	}
	return m
}

// File adds a file part; nil adds nothing.
func (m *MultipartBody) File(name string, file *File) *MultipartBody {
	if file != nil {
		m.parts = append(m.parts, multipartPart{name: name, file: file})
	}
	return m
}

// Files adds one file part per file.
func (m *MultipartBody) Files(name string, files []File) *MultipartBody {
	for i := range files {
		m.File(name, &files[i])
	}
	return m
}

func (m *MultipartBody) Replayable() bool    { return true }
func (m *MultipartBody) ContentType() string { return "multipart/form-data; boundary=" + m.boundary }

func (m *MultipartBody) Open() (io.Reader, int64, error) {
	if m.err != nil {
		return nil, 0, m.err
	}
	var b bytes.Buffer
	for _, part := range m.parts {
		b.WriteString("--" + m.boundary + "\r\n")
		// filename* is not written: some servers reject it.
		if part.file == nil {
			b.WriteString(`Content-Disposition: form-data; name="` + quoteDisposition(part.name) + "\"\r\n\r\n")
			b.WriteString(part.text)
		} else {
			fileName := part.file.Name
			if fileName == "" {
				fileName = "blob"
			}
			contentType := part.file.ContentType
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			b.WriteString(`Content-Disposition: form-data; name="` + quoteDisposition(part.name) + `"; filename="` + quoteDisposition(fileName) + "\"\r\n")
			b.WriteString("Content-Type: " + contentType + "\r\n\r\n")
			b.Write(part.file.Content)
		}
		b.WriteString("\r\n")
	}
	b.WriteString("--" + m.boundary + "--\r\n")
	return bytes.NewReader(b.Bytes()), int64(b.Len()), nil
}

// quoteDisposition escapes a disposition value the way browsers do (`"` and line breaks are percent-encoded).
func quoteDisposition(value string) string {
	return strings.NewReplacer(`"`, "%22", "\r", "%0D", "\n", "%0A").Replace(value)
}
