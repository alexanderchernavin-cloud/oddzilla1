// HTTP handler exposing the signer's two operations over a Unix socket.
//
// The transport is plain HTTP (no TLS) because the only client is the
// API container connecting through a shared Unix socket — an attacker
// in a position to MITM that path is already inside the container, at
// which point TLS doesn't help. Authentication is filesystem
// permissions: the socket is mode 0660 owned by node:node, and only
// the signer + API containers mount the volume.
//
// Endpoints:
//   POST /derive   {"network": "ERC20"|"TRC20", "userIndex": uint32}
//                  → {"address": string, "derivationPath": string}
//   POST /sign     {"derivationPath": string, "messageHash": "<hex,32B>",
//                   "auditTag": string (optional, e.g. "withdrawal:<uuid>")}
//                  → {"signature": "<hex,65B>", "address": "<hex,eth-form>"}
//
// Every /sign call is logged at INFO with (path, hash, auditTag) so a
// post-fact audit can confirm that signed payloads match approved
// withdrawals. The signer never decides what's worth signing — its
// caller is responsible for authorisation.

package server

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/rs/zerolog"

	"github.com/oddzilla/signer/internal/derive"
	"github.com/oddzilla/signer/internal/sign"
)

type Server struct {
	root *derive.Root // may be nil → idle mode (HD_MASTER_MNEMONIC unset)
	log  zerolog.Logger
}

func New(root *derive.Root, log zerolog.Logger) *Server {
	return &Server{root: root, log: log}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /derive", s.handleDerive)
	mux.HandleFunc("POST /sign", s.handleSign)
	return mux
}

// rootOr503 returns the loaded root key or writes a 503 to w. Used by
// every endpoint that needs the secret material. Callers should
// `return` immediately after the false branch.
func (s *Server) rootOr503(w http.ResponseWriter) (*derive.Root, bool) {
	if s.root == nil {
		writeErr(w, http.StatusServiceUnavailable, "signer_idle",
			"HD_MASTER_MNEMONIC is unset on the signer container; restart it after configuring")
		return nil, false
	}
	return s.root, true
}

type deriveReq struct {
	Network   string `json:"network"`
	UserIndex uint32 `json:"userIndex"`
}
type deriveResp struct {
	Address        string `json:"address"`
	DerivationPath string `json:"derivationPath"`
}

func (s *Server) handleDerive(w http.ResponseWriter, r *http.Request) {
	root, ok := s.rootOr503(w)
	if !ok {
		return
	}
	var req deriveReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	path, err := derive.PathFor(req.Network, req.UserIndex)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_network", err.Error())
		return
	}
	var address string
	switch req.Network {
	case "ERC20":
		address, err = root.EthereumAddress(req.UserIndex)
	case "TRC20":
		address, err = root.TronAddress(req.UserIndex)
	}
	if err != nil {
		s.log.Error().Err(err).Str("network", req.Network).Uint32("idx", req.UserIndex).Msg("derive failed")
		writeErr(w, http.StatusInternalServerError, "derive_failed", "internal")
		return
	}
	writeJSON(w, http.StatusOK, deriveResp{Address: address, DerivationPath: path})
}

type signReq struct {
	DerivationPath string `json:"derivationPath"`
	MessageHash    string `json:"messageHash"`
	AuditTag       string `json:"auditTag"`
}
type signResp struct {
	Signature string `json:"signature"`
	Address   string `json:"address"`
}

func (s *Server) handleSign(w http.ResponseWriter, r *http.Request) {
	root, ok := s.rootOr503(w)
	if !ok {
		return
	}
	var req signReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	hashStr := strings.TrimPrefix(req.MessageHash, "0x")
	hashBytes, err := hex.DecodeString(hashStr)
	if err != nil || len(hashBytes) != 32 {
		writeErr(w, http.StatusBadRequest, "invalid_hash", "messageHash must be 0x-prefixed 32-byte hex")
		return
	}
	priv, err := root.PrivateKeyAt(req.DerivationPath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}
	sig, err := sign.Hash(priv, hashBytes)
	if err != nil {
		s.log.Error().Err(err).Msg("sign failed")
		writeErr(w, http.StatusInternalServerError, "sign_failed", "internal")
		return
	}

	// Best-effort audit log. The real authorisation lives in admin_audit_log
	// on the API side; this is just a signer-process trace so post-fact
	// reconciliation can prove which hashes left the signer.
	s.log.Info().
		Str("event", "sign").
		Str("path", req.DerivationPath).
		Str("hash", "0x"+hashStr).
		Str("audit_tag", req.AuditTag).
		Msg("signed")

	// The "address" field is the ETH-form address derived from the
	// public key — useful as a cross-check that the caller hashed the
	// right tx for the right account before broadcasting.
	addr := derive.EthereumAddressFromPriv(priv)

	writeJSON(w, http.StatusOK, signResp{
		Signature: "0x" + hex.EncodeToString(sig),
		Address:   addr,
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
