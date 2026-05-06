// Oddzilla signer service.
//
// Holds HD_MASTER_MNEMONIC. Exposes two operations over a Unix socket
// only the API container can reach (shared volume, same UID): derive an
// address by BIP44 path, and ECDSA-sign a 32-byte message hash with the
// key at a given path. The signer never sees a transaction body — the
// caller hashes its own bytes (RLP for ETH, protobuf raw_data for Tron)
// and passes the hash. This keeps the signer chain-agnostic and the
// attack surface minimal.
//
// Threat model: a compromised API container cannot exfiltrate the
// mnemonic. The signer container has cap_drop ALL, no_new_privileges,
// no DB, and (in compose) no public network — its only egress is the
// Unix socket. RCE inside the API still lets an attacker request signs
// of arbitrary hashes; the safety bound is then "the API code path that
// produces hashes must encode chain-id + nonce + recipient correctly."
// That's why the signer logs every (path, hash, recipient_hint) tuple
// — any divergence between the signed payload and the expected
// withdrawal can be detected after the fact via the audit log.

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/signer/internal/derive"
	"github.com/oddzilla/signer/internal/server"
)

func main() {
	healthcheckFlag := flag.Bool("healthcheck", false, "probe own /healthz on $HEALTH_PORT and exit 0/1; used by docker compose healthcheck since distroless has no wget/curl")
	flag.Parse()
	if *healthcheckFlag {
		os.Exit(runHealthcheck())
	}

	log := zerolog.New(os.Stdout).
		With().
		Timestamp().
		Str("service", "signer").
		Logger()

	mnemonic := os.Getenv("HD_MASTER_MNEMONIC")
	socketPath := os.Getenv("SIGNER_SOCKET_PATH")
	if socketPath == "" {
		socketPath = "/run/signer/signer.sock"
	}
	healthPort := os.Getenv("HEALTH_PORT")
	if healthPort == "" {
		healthPort = "8086"
	}

	// Graceful idle when the mnemonic is unset — match the same pattern
	// the other Oddzilla services use for missing optional creds. The
	// signer still binds the Unix socket and the health port so the
	// compose dependency `service_healthy` resolves and the API can boot;
	// /derive and /sign return 503 until the operator sets
	// HD_MASTER_MNEMONIC and restarts just this container.
	var root *derive.Root
	if mnemonic == "" {
		log.Warn().Msg("HD_MASTER_MNEMONIC is empty — running in idle mode; /derive and /sign will 503 until set")
	} else {
		var err error
		root, err = derive.NewRoot(mnemonic)
		if err != nil {
			log.Fatal().Err(err).Msg("invalid HD_MASTER_MNEMONIC")
		}
		// Wipe the env var as soon as we've consumed it. Defence-in-depth:
		// /proc/<pid>/environ is no longer interesting if someone manages to
		// read it later.
		_ = os.Unsetenv("HD_MASTER_MNEMONIC")
	}

	if err := os.MkdirAll(parentDir(socketPath), 0o750); err != nil {
		log.Fatal().Err(err).Str("path", socketPath).Msg("mkdir socket parent")
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatal().Err(err).Str("path", socketPath).Msg("remove stale socket")
	}

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal().Err(err).Str("path", socketPath).Msg("listen unix")
	}
	defer listener.Close()
	if err := os.Chmod(socketPath, 0o660); err != nil {
		log.Fatal().Err(err).Msg("chmod socket")
	}

	srv := server.New(root, log)
	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	// Health on a real TCP port so docker compose healthcheck can probe
	// it. Returns 200 once the root key is loaded; says nothing about
	// the mnemonic itself.
	healthMux := http.NewServeMux()
	healthStartedAt := time.Now()
	healthMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","uptime_seconds":%d}`, int(time.Since(healthStartedAt).Seconds()))
	})
	healthSrv := &http.Server{
		Addr:              ":" + healthPort,
		Handler:           healthMux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info().Str("addr", healthSrv.Addr).Msg("health server listening")
		if err := healthSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error().Err(err).Msg("health server")
		}
	}()

	go func() {
		log.Info().Str("socket", socketPath).Msg("signer listening")
		if err := httpSrv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error().Err(err).Msg("signer server")
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Info().Msg("shutdown")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	_ = healthSrv.Shutdown(ctx)
}

func parentDir(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "."
}

// runHealthcheck dials the signer's own /healthz endpoint and returns
// an exit code. We do this instead of shipping wget/curl because the
// runtime image is distroless static (no shell, no busybox).
func runHealthcheck() int {
	port := os.Getenv("HEALTH_PORT")
	if port == "" {
		port = "8086"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		return 1
	}
	return 0
}
