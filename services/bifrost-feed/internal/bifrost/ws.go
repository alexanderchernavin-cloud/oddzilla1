// graphql-transport-ws client. Bifrost multiplexes every subscription over
// one socket: connection_init carries the same headers the HTTP path
// sends, then any number of `subscribe` frames each tagged with our own
// id, and the server answers with `next` frames tagged the same way.
//
// The socket URL also carries `?apiKey=` because the server authenticates
// the upgrade before it ever sees connection_init (copied from the
// front end's own link setup).

package bifrost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
)

// Frame is one server → client protocol message.
type Frame struct {
	ID      string
	Type    string // next | error | complete
	Payload json.RawMessage
}

type wsMessage struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// ConnectionInfo is what Bifrost echoes back in connection_ack: which
// client the key belongs to. Logged once per connect so a key swap is
// visible in the logs.
type ConnectionInfo struct {
	Client struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"client"`
}

type WS struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	frames  chan Frame
	done    chan struct{}
	errMu   sync.Mutex
	err     error
	log     zerolog.Logger
	Info    ConnectionInfo
}

const (
	wsHandshakeTimeout = 15 * time.Second
	wsAckTimeout       = 10 * time.Second
	wsWriteTimeout     = 10 * time.Second
	// wsReadTimeout is how long the socket may be silent before we treat
	// it as dead. A quiet prematch catalogue still gets our own ping every
	// wsPingEvery, so silence past this means the server stopped answering.
	wsReadTimeout = 90 * time.Second
	wsPingEvery   = 30 * time.Second
	wsMaxMessage  = 16 << 20
)

// Dial opens the socket, completes connection_init / connection_ack and
// starts the reader. The returned WS must be Closed by the caller.
func Dial(ctx context.Context, wsURL string, c *Client, log zerolog.Logger) (*WS, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: wsHandshakeTimeout,
		Subprotocols:     []string{"graphql-transport-ws"},
	}
	hdr := http.Header{}
	hdr.Set("Origin", c.Origin())
	hdr.Set("User-Agent", "oddzilla-bifrost-feed/1.0")
	url := fmt.Sprintf("%s?apiKey=%s&t=%d", wsURL, c.APIKey(), time.Now().UnixMilli())
	conn, resp, err := dialer.DialContext(ctx, url, hdr)
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return nil, fmt.Errorf("ws dial: HTTP %d: %w", resp.StatusCode, ErrUnauthorized)
		}
		return nil, fmt.Errorf("ws dial: %w", err)
	}
	conn.SetReadLimit(wsMaxMessage)

	w := &WS{
		conn:   conn,
		frames: make(chan Frame, 1024),
		done:   make(chan struct{}),
		log:    log.With().Str("component", "bifrost-ws").Logger(),
	}

	initPayload, _ := json.Marshal(c.Headers())
	if err := w.write(wsMessage{Type: "connection_init", Payload: initPayload}); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ws connection_init: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(wsAckTimeout))
	var ack wsMessage
	if err := conn.ReadJSON(&ack); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ws connection_ack read: %w", err)
	}
	if ack.Type != "connection_ack" {
		conn.Close()
		return nil, fmt.Errorf("ws expected connection_ack, got %q", ack.Type)
	}
	_ = json.Unmarshal(ack.Payload, &w.Info)
	_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))

	go w.readLoop()
	go w.pingLoop()
	return w, nil
}

// Subscribe starts one operation under the caller-chosen id.
func (w *WS) Subscribe(id, operationName, query string, variables map[string]any) error {
	payload, err := json.Marshal(gqlRequest{OperationName: operationName, Query: query, Variables: variables})
	if err != nil {
		return err
	}
	return w.write(wsMessage{ID: id, Type: "subscribe", Payload: payload})
}

// Complete stops one operation. Best-effort: a server that already
// dropped the subscription ignores it.
func (w *WS) Complete(id string) error {
	return w.write(wsMessage{ID: id, Type: "complete"})
}

// Frames delivers next / error / complete frames. Closed when the socket
// dies; Err then reports why.
func (w *WS) Frames() <-chan Frame { return w.frames }

// Err returns the terminal error once Frames is closed.
func (w *WS) Err() error {
	w.errMu.Lock()
	defer w.errMu.Unlock()
	return w.err
}

// Close tears the socket down and unblocks the reader.
func (w *WS) Close() {
	w.writeMu.Lock()
	_ = w.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(2*time.Second))
	w.writeMu.Unlock()
	_ = w.conn.Close()
}

func (w *WS) write(msg wsMessage) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return w.conn.WriteJSON(msg)
}

func (w *WS) fail(err error) {
	w.errMu.Lock()
	if w.err == nil {
		w.err = err
	}
	w.errMu.Unlock()
}

func (w *WS) readLoop() {
	defer close(w.frames)
	defer close(w.done)
	for {
		var msg wsMessage
		if err := w.conn.ReadJSON(&msg); err != nil {
			w.fail(fmt.Errorf("ws read: %w", err))
			return
		}
		_ = w.conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		switch msg.Type {
		case "ping":
			if err := w.write(wsMessage{Type: "pong"}); err != nil {
				w.fail(fmt.Errorf("ws pong: %w", err))
				return
			}
		case "pong", "connection_ack":
			// keepalive answers; nothing to deliver
		case "next", "error", "complete":
			w.frames <- Frame{ID: msg.ID, Type: msg.Type, Payload: msg.Payload}
		default:
			w.log.Debug().Str("type", msg.Type).Msg("unhandled ws frame type")
		}
	}
}

// pingLoop sends a protocol-level ping so a quiet catalogue never lets the
// read deadline expire on a healthy socket, and so a half-open TCP session
// surfaces as a write error rather than eternal silence.
func (w *WS) pingLoop() {
	t := time.NewTicker(wsPingEvery)
	defer t.Stop()
	for {
		select {
		case <-w.done:
			return
		case <-t.C:
			if err := w.write(wsMessage{Type: "ping"}); err != nil {
				w.fail(fmt.Errorf("ws ping: %w", err))
				_ = w.conn.Close()
				return
			}
		}
	}
}

// IsUnauthorized reports whether err stems from a rejected key.
func IsUnauthorized(err error) bool { return errors.Is(err, ErrUnauthorized) }
