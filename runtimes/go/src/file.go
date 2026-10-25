package core

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// File is the content of a binary body or a multipart file part. Inside JSON it is a base64 string (the name
// and the content type are not part of JSON). The content is held in memory so a request can be sent again
// (redirects, retries).
type File struct {
	Content []byte
	// Name is the multipart filename ("blob" when empty).
	Name string
	// ContentType is the multipart part's Content-Type (application/octet-stream when empty); a binary body
	// uses it only when the operation declares no media type.
	ContentType string
}

// ReadFile reads r into a File.
func ReadFile(r io.Reader, name, contentType string) (File, error) {
	content, err := io.ReadAll(r)
	if err != nil {
		return File{}, err
	}
	return File{Content: content, Name: name, ContentType: contentType}, nil
}

// MarshalJSON writes the content as a base64 string.
func (f File) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.StdEncoding.EncodeToString(f.Content))
}

// UnmarshalJSON reads the content from a base64 string.
func (f *File) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return fmt.Errorf("invalid base64 file content: %w", err)
	}
	*f = File{Content: content}
	return nil
}

// Date is a calendar date without a time or a time zone (OpenAPI `format: date`), written as YYYY-MM-DD.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// DateOf returns the date of t in t's location.
func DateOf(t time.Time) Date {
	year, month, day := t.Date()
	return Date{Year: year, Month: month, Day: day}
}

// ParseDate parses YYYY-MM-DD.
func ParseDate(s string) (Date, error) {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		return Date{}, err
	}
	return DateOf(t), nil
}

// String returns the date as YYYY-MM-DD.
func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.Year, int(d.Month), d.Day)
}

// In returns the start of the date in loc.
func (d Date) In(loc *time.Location) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, loc)
}

// MarshalJSON writes the date as a YYYY-MM-DD string.
func (d Date) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

// UnmarshalJSON reads a YYYY-MM-DD string.
func (d *Date) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	parsed, err := ParseDate(text)
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}
