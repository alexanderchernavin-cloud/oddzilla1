package amqp

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// dialCounter is a TCP listener that counts connection attempts and drops
// them immediately. The AMQP handshake then fails, which is all we need:
// the question under test is whether Run dials at all, not whether it can
// speak the protocol.
func dialCounter(t *testing.T) (host string, port int, accepts *int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var n int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&n, 1)
			_ = conn.Close()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port, &n
}

func newTestConsumer(t *testing.T, host string, port int) *Consumer {
	t.Helper()
	return New(Config{
		Host:        host,
		Port:        port,
		Token:       "t",
		CustomerID:  "142",
		DialTimeout: 200 * time.Millisecond,
	}, func(context.Context, string, []byte) error { return nil },
		func(context.Context) error { return nil }, zerolog.Nop())
}

// While the operator has forced a non-Oddin feed source, Run must not
// dial. Before the gate existed, a forced Backup with revoked credentials
// logged a 403 every 30 s forever against a source the operator had
// explicitly switched off (production, 2026-09-04).
func TestRunDoesNotDialWhilePaused(t *testing.T) {
	host, port, accepts := dialCounter(t)
	c := newTestConsumer(t, host, port)
	c.Paused = func() bool { return true }

	ctx, cancel := context.WithTimeout(context.Background(), 3*pauseInterval)
	defer cancel()
	done := make(chan struct{})
	go func() { _ = c.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("Run did not return after ctx expiry")
	}

	if n := atomic.LoadInt32(accepts); n != 0 {
		t.Fatalf("dialled %d time(s) while paused; the gate leaks", n)
	}
}

// Clearing the gate has to let the loop dial again within a poll or two,
// otherwise switching the source back to Oddin would need a restart.
func TestRunResumesWhenUnpaused(t *testing.T) {
	host, port, accepts := dialCounter(t)
	c := newTestConsumer(t, host, port)
	var paused atomic.Bool
	paused.Store(true)
	c.Paused = paused.Load

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { _ = c.Run(ctx); close(done) }()

	// Confirm the pause holds first, so a pass cannot come from a dial
	// that happened before we ever un-paused.
	time.Sleep(2 * pauseInterval)
	if n := atomic.LoadInt32(accepts); n != 0 {
		t.Fatalf("dialled %d time(s) before being un-paused", n)
	}

	paused.Store(false)
	deadline := time.After(4 * pauseInterval)
	for atomic.LoadInt32(accepts) == 0 {
		select {
		case <-deadline:
			t.Fatal("did not dial within four poll intervals of being un-paused")
		case <-time.After(20 * time.Millisecond):
		}
	}
	cancel()
	<-done
}
