// Package relay converts raw RFC 5322 messages into the multipart
// payload that SendGrid Inbound Parse would have sent, and POSTs to
// our existing inbound webhook.
//
// We mimic SendGrid's payload shape so the api-side webhook handler
// stays identical. The shape (from SendGrid's Inbound Parse docs):
//
//   to            — header To value (string)
//   from          — header From value (string)
//   subject       — header Subject value (string)
//   text          — text/plain body (string, optional)
//   html          — text/html body  (string, optional)
//   headers       — full raw header block (string)
//   envelope      — JSON: {"to": [...], "from": "..."}
//   spam_score    — numeric string (optional; we don't compute this,
//                   so we omit it)
//   attachments   — count (string)
//   attachment-info — JSON per-attachment map
//   attachment1, attachment2, ... — file parts
//
// At this stage we do NOT persist attachments. The webhook also drops
// their contents — only metadata flows through. We include each
// attachment as a file-part with the correct headers so the webhook's
// content parser still records its filename / type / size.

package relay

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/textproto"
	"strings"
	"time"
)

// Input is one inbound message ready to be relayed.
type Input struct {
	// SMTP envelope MAIL FROM. May differ from the RFC 5322 From header
	// (forwarders, mailing lists). Captured verbatim for the envelope
	// field.
	EnvelopeFrom string
	// SMTP envelope RCPT TO list.
	Recipients []string
	// The raw RFC 5322 message — headers + body, exactly as it arrived.
	Raw []byte
}

// Client POSTs translated payloads to the webhook URL.
type Client struct {
	url    string
	secret string
	http   *http.Client
}

func New(url, secret string) *Client {
	// One-process HTTP client with sane timeouts. Webhook is on the
	// same docker network so latency is sub-ms; total cap of 30s
	// absorbs an api process restart without losing the mail (SMTP
	// 451 → sender retries).
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		MaxIdleConns:          4,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &Client{
		url:    strings.TrimRight(url, "/") + "/" + secret,
		secret: secret,
		http: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
		},
	}
}

// Forward parses the raw message and POSTs as multipart/form-data.
func (c *Client) Forward(in Input) error {
	msg, err := mail.ReadMessage(bytes.NewReader(in.Raw))
	if err != nil {
		return fmt.Errorf("parse message: %w", err)
	}

	parsed, err := parseBody(msg)
	if err != nil {
		return fmt.Errorf("parse body: %w", err)
	}

	headers := buildRawHeaders(in.Raw)
	envelope := buildEnvelope(in.EnvelopeFrom, in.Recipients)

	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)

	add := func(field, value string) error {
		if value == "" {
			return nil
		}
		return w.WriteField(field, value)
	}

	if err := add("to", msg.Header.Get("To")); err != nil {
		return err
	}
	if err := add("from", msg.Header.Get("From")); err != nil {
		return err
	}
	if err := add("subject", decodeRFC2047(msg.Header.Get("Subject"))); err != nil {
		return err
	}
	if err := add("text", parsed.Text); err != nil {
		return err
	}
	if err := add("html", parsed.HTML); err != nil {
		return err
	}
	if err := add("headers", headers); err != nil {
		return err
	}
	if err := add("envelope", envelope); err != nil {
		return err
	}
	if len(parsed.Attachments) > 0 {
		if err := add("attachments", fmt.Sprintf("%d", len(parsed.Attachments))); err != nil {
			return err
		}
		info := make(map[string]map[string]string, len(parsed.Attachments))
		for i, a := range parsed.Attachments {
			info[fmt.Sprintf("attachment%d", i+1)] = map[string]string{
				"filename": a.Filename,
				"type":     a.ContentType,
			}
			// Each attachment becomes a file field. The webhook reads
			// the part stream into /dev/null but records the filename
			// + content-type + byte count.
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="attachment%d"; filename=%q`, i+1, a.Filename))
			if a.ContentType != "" {
				h.Set("Content-Type", a.ContentType)
			}
			part, err := w.CreatePart(h)
			if err != nil {
				return err
			}
			if _, err := part.Write(a.Data); err != nil {
				return err
			}
		}
		blob, _ := json.Marshal(info)
		if err := add("attachment-info", string(blob)); err != nil {
			return err
		}
	}

	if err := w.Close(); err != nil {
		return err
	}

	req, err := http.NewRequest("POST", c.url, buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	// Origin is bypassed for /webhooks/* on the api side (path-secret is
	// the auth gate) so no header needed. User-Agent helps the operator
	// recognise our own deliveries in the api logs.
	req.Header.Set("User-Agent", "oddzilla-mail-receiver/1")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	// Drain so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook status %d", resp.StatusCode)
	}
	return nil
}

type parsedBody struct {
	Text        string
	HTML        string
	Attachments []attachment
}

type attachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

// parseBody walks the MIME structure. For multipart messages we recurse
// into each part; for single-part we read the body into Text or HTML
// based on the top-level content type. Decodes quoted-printable / base64
// per RFC 2045.
func parseBody(msg *mail.Message) (parsedBody, error) {
	contentType := msg.Header.Get("Content-Type")
	if contentType == "" {
		// Plain text by default.
		body, err := io.ReadAll(msg.Body)
		if err != nil {
			return parsedBody{}, err
		}
		return parsedBody{Text: decodeBody(body, msg.Header.Get("Content-Transfer-Encoding"), "")}, nil
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return parsedBody{}, fmt.Errorf("content-type: %w", err)
	}
	out := parsedBody{}
	if !strings.HasPrefix(mediaType, "multipart/") {
		// Single-part body.
		body, err := io.ReadAll(msg.Body)
		if err != nil {
			return out, err
		}
		decoded := decodeBody(body, msg.Header.Get("Content-Transfer-Encoding"), params["charset"])
		if mediaType == "text/html" {
			out.HTML = decoded
		} else {
			out.Text = decoded
		}
		return out, nil
	}
	if err := walkParts(msg.Body, params["boundary"], &out); err != nil {
		return out, err
	}
	return out, nil
}

func walkParts(r io.Reader, boundary string, out *parsedBody) error {
	if boundary == "" {
		return errors.New("multipart with no boundary")
	}
	mr := multipart.NewReader(r, boundary)
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		ctype := p.Header.Get("Content-Type")
		disposition := p.Header.Get("Content-Disposition")
		dispMediaType, dispParams, _ := mime.ParseMediaType(disposition)
		isAttachment := strings.HasPrefix(dispMediaType, "attachment") || dispParams["filename"] != ""

		body, err := io.ReadAll(p)
		if err != nil {
			return err
		}

		if isAttachment {
			filename := dispParams["filename"]
			if filename == "" {
				filename = "attachment"
			}
			filename = decodeRFC2047(filename)
			out.Attachments = append(out.Attachments, attachment{
				Filename:    filename,
				ContentType: stripParams(ctype),
				Data:        decodeBytes(body, p.Header.Get("Content-Transfer-Encoding")),
			})
			continue
		}

		mediaType, params, _ := mime.ParseMediaType(ctype)
		if strings.HasPrefix(mediaType, "multipart/") {
			// Nested multipart (e.g. multipart/alternative inside
			// multipart/mixed). Recurse.
			if err := walkParts(bytes.NewReader(body), params["boundary"], out); err != nil {
				return err
			}
			continue
		}

		decoded := decodeBody(body, p.Header.Get("Content-Transfer-Encoding"), params["charset"])
		switch mediaType {
		case "text/html":
			if out.HTML == "" {
				out.HTML = decoded
			}
		case "text/plain":
			if out.Text == "" {
				out.Text = decoded
			}
		}
	}
}

func decodeBody(body []byte, encoding, charset string) string {
	decoded := decodeBytes(body, encoding)
	// Charset conversion is beyond first slice — Go's stdlib only
	// handles utf-8 / us-ascii out of the box. Most modern senders
	// emit utf-8; non-utf8 senders may render with bad characters
	// until we wire golang.org/x/text/encoding. Bounded cost, MVP-ok.
	return string(decoded)
}

func decodeBytes(body []byte, encoding string) []byte {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "quoted-printable":
		w := &bytes.Buffer{}
		dec := quotedprintable.NewReader(bytes.NewReader(body))
		if _, err := io.Copy(w, dec); err == nil {
			return w.Bytes()
		}
	case "base64":
		// Strip whitespace/newlines that wrap base64 in mail bodies,
		// then decode. base64.StdEncoding is strict about characters
		// but tolerant about padding when we use DecodeString.
		clean := bytes.Map(func(r rune) rune {
			if r == '\r' || r == '\n' || r == '\t' || r == ' ' {
				return -1
			}
			return r
		}, body)
		if dec, err := base64.StdEncoding.DecodeString(string(clean)); err == nil {
			return dec
		}
		// Fall back to RawStdEncoding for unpadded mail bodies.
		if dec, err := base64.RawStdEncoding.DecodeString(string(clean)); err == nil {
			return dec
		}
	}
	return body
}

// buildRawHeaders extracts the raw header block (everything before
// the first empty line) from the full message. We hand this to the
// webhook so the api-side parser can pull Message-ID / In-Reply-To /
// References without re-parsing the body.
func buildRawHeaders(raw []byte) string {
	// Find first CRLF CRLF or LF LF (end of headers).
	idx := bytes.Index(raw, []byte("\r\n\r\n"))
	if idx == -1 {
		idx = bytes.Index(raw, []byte("\n\n"))
	}
	if idx == -1 {
		return string(raw)
	}
	return string(raw[:idx])
}

func buildEnvelope(from string, to []string) string {
	type envelope struct {
		From string   `json:"from"`
		To   []string `json:"to"`
	}
	blob, _ := json.Marshal(envelope{From: from, To: to})
	return string(blob)
}

// decodeRFC2047 decodes "=?utf-8?B?...?=" header words. Returns the
// input unchanged on failure.
func decodeRFC2047(s string) string {
	dec := new(mime.WordDecoder)
	if r, err := dec.DecodeHeader(s); err == nil {
		return r
	}
	return s
}

func stripParams(contentType string) string {
	if i := strings.Index(contentType, ";"); i >= 0 {
		return strings.TrimSpace(contentType[:i])
	}
	return strings.TrimSpace(contentType)
}
