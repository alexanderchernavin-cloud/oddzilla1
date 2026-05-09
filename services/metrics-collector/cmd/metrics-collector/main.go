// Oddzilla metrics-collector service.
//
// Runs alongside the rest of the stack and exposes a single HTTP
// endpoint (`GET /snapshot`) that returns host-level system metrics +
// per-container Docker state. The api container polls this endpoint
// every 60s to power the /admin/monitoring page; nothing else on the
// docker network has a reason to reach it, and it is never fronted by
// Caddy.
//
// Threat model. The collector holds three potentially-sensitive bind
// mounts: read-only access to host /proc, host /, and the docker.sock.
// To shrink the blast radius if the collector is RCE'd:
//   - cap_drop: ALL + no_new_privileges + read_only rootfs (compose).
//   - Runs as nobody (UID 65534) so even if a path slipped past the
//     ro mount, the process has zero ambient privilege on the host.
//   - Has no DB / Redis / outbound credentials — its only output is the
//     JSON over the docker network, on a non-public port.
//   - The docker.sock mount is :ro, which the engine enforces; an
//     attacker who escapes the read-only rootfs still cannot
//     `docker run --privileged` from inside this container.
//
// Compared to bolting these mounts onto the api container directly
// (the alternative considered), a separate collector means a future
// API-side RCE does not also yield host filesystem read + dockerd
// reach.

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/metrics-collector/internal/dockerstat"
	"github.com/oddzilla/metrics-collector/internal/host"
	"github.com/oddzilla/metrics-collector/internal/server"
)

func main() {
	healthcheckFlag := flag.Bool("healthcheck", false, "probe own /healthz on $PORT and exit 0/1; used by docker compose since distroless has no wget/curl")
	flag.Parse()
	if *healthcheckFlag {
		os.Exit(runHealthcheck())
	}

	log := zerolog.New(os.Stdout).
		With().
		Timestamp().
		Str("service", "metrics-collector").
		Logger()

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}
	socketPath := os.Getenv("DOCKER_SOCKET_PATH")
	if socketPath == "" {
		socketPath = dockerstat.DockerSocketPath
	}

	hostReader := host.NewReader()
	dockerClient := dockerstat.NewClient(socketPath)

	// Sanity probes at boot so a misconfiguration (missing /host/proc
	// mount, missing docker.sock) shows up in the log immediately rather
	// than waiting for the first /snapshot call. Errors are warnings,
	// not fatals — `_, err := hostReader.Read()` will fail too, and the
	// API surfaces "metrics unavailable" gracefully.
	if _, err := hostReader.Read(); err != nil {
		log.Warn().Err(err).Msg("host read sanity probe failed; check /host/proc + /host-root mounts")
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 2*time.Second)
	if _, err := dockerClient.ListContainers(probeCtx); err != nil {
		log.Warn().Err(err).Msg("docker socket probe failed; check /var/run/docker.sock mount")
	}
	probeCancel()

	srv := server.New(hostReader, dockerClient, log)
	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	go func() {
		log.Info().Str("addr", httpSrv.Addr).Msg("metrics-collector listening")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error().Err(err).Msg("server")
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Info().Msg("shutdown")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

// runHealthcheck dials our own /healthz and returns an exit code. Used
// by docker compose because the distroless static runtime image has
// no wget / curl.
func runHealthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
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
