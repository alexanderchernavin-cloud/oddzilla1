// Package server wires the host metrics + docker stats into one HTTP
// surface. The collector exposes two endpoints to the api container on
// the docker default network — never to the public internet.
//
//   GET /healthz
//     Liveness probe used by docker compose. Returns 200 once the
//     server has started; says nothing about the host metrics.
//
//   GET /snapshot
//     One JSON object combining { ts, host, containers }. CPU% on the
//     host block is null on the first call after process start; the
//     api caller polls every 60s, so the first /snapshot lands a
//     baseline and every later call returns a real value.
//
// Auth: filesystem permissions on the docker network. The collector
// has no /var/run/docker.sock writers — its mount is `:ro`, and the
// api container sits behind admin-role middleware before reaching us.

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/metrics-collector/internal/dockerstat"
	"github.com/oddzilla/metrics-collector/internal/host"
)

type Server struct {
	hostReader   *host.Reader
	dockerClient *dockerstat.Client
	log          zerolog.Logger
	startedAt    time.Time
}

func New(hostReader *host.Reader, dockerClient *dockerstat.Client, log zerolog.Logger) *Server {
	return &Server{
		hostReader:   hostReader,
		dockerClient: dockerClient,
		log:          log,
		startedAt:    time.Now(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /snapshot", s.handleSnapshot)
	return mux
}

type snapshotResp struct {
	TS         int64                 `json:"ts"`
	Host       *host.Snapshot        `json:"host"`
	Containers []dockerstat.Container `json:"containers"`
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	hostSnap, err := s.hostReader.Read()
	if err != nil {
		s.log.Error().Err(err).Msg("host read failed")
		writeErr(w, http.StatusInternalServerError, "host_read_failed", err.Error())
		return
	}

	// Container list errors are non-fatal — host metrics still render
	// the page. Empty list + a logged warning is more useful to the
	// operator than a hard 500 (which would mask the host signal).
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	containers, err := s.dockerClient.ListContainers(ctx)
	if err != nil {
		s.log.Warn().Err(err).Msg("container list failed; returning empty list")
		containers = []dockerstat.Container{}
	}

	writeJSON(w, http.StatusOK, snapshotResp{
		TS:         time.Now().Unix(),
		Host:       hostSnap,
		Containers: containers,
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":        "ok",
		"uptimeSeconds": int(time.Since(s.startedAt).Seconds()),
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}
