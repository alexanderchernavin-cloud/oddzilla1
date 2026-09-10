package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/oddzilla/slotzilla/internal/rules"
)

// Config is the slotzilla_config singleton as the engine reads it.
type Config struct {
	Enabled                bool
	Currencies             []string
	RTPTargetBp            int
	LeadSeconds            int
	ClockPastSeconds       int
	GraceSeconds           int
	FeedDarkVoidSeconds    int
	MinStakeMicro          int64
	MaxStakeMicro          int64
	MaxPayoutMicro         int64
	MatchLiabilityCapMicro int64
	AutoplayEnabled        bool
}

const sqlLoadConfig = `
SELECT enabled, currencies, rtp_target_bp, lead_seconds, clock_past_seconds, grace_seconds,
       feed_dark_void_seconds, min_stake_micro, max_stake_micro, max_payout_micro,
       match_liability_cap_micro, autoplay_enabled
  FROM slotzilla_config
 WHERE id = 'default'`

// LoadConfig reads the operator settings. A missing row (the migration
// seeds one) reads as disabled rather than as an error, so the service
// idles instead of crashlooping on a half-applied migration.
func (s *Store) LoadConfig(ctx context.Context) (Config, error) {
	var c Config
	err := s.pool.QueryRow(ctx, sqlLoadConfig).Scan(
		&c.Enabled, &c.Currencies, &c.RTPTargetBp, &c.LeadSeconds, &c.ClockPastSeconds, &c.GraceSeconds,
		&c.FeedDarkVoidSeconds, &c.MinStakeMicro, &c.MaxStakeMicro, &c.MaxPayoutMicro,
		&c.MatchLiabilityCapMicro, &c.AutoplayEnabled,
	)
	if err != nil {
		if isNoRows(err) {
			return Config{}, nil
		}
		return Config{}, fmt.Errorf("load slotzilla_config: %w", err)
	}
	return c, nil
}

const sqlActivePaytableID = `SELECT id FROM slotzilla_paytables WHERE active LIMIT 1`

// ActivePaytableID returns the one active paytable, ok=false when none is.
func (s *Store) ActivePaytableID(ctx context.Context) (int64, bool, error) {
	var id int64
	if err := s.pool.QueryRow(ctx, sqlActivePaytableID).Scan(&id); err != nil {
		if isNoRows(err) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("active paytable: %w", err)
	}
	return id, true, nil
}

const sqlPaytableLines = `SELECT lines FROM slotzilla_paytables WHERE id = $1`

// PaytableLines loads one paytable's multipliers. Keys that are not line
// keys are dropped (the admin route validates them, but a hand-edited row
// must not reach the settler as a line it cannot evaluate); a multiplier
// that is not a non-negative integer is an error, because it would pay.
func (s *Store) PaytableLines(ctx context.Context, id int64) (rules.PaytableLines, error) {
	var raw []byte
	if err := s.pool.QueryRow(ctx, sqlPaytableLines, id).Scan(&raw); err != nil {
		return nil, fmt.Errorf("paytable %d: %w", id, err)
	}
	return decodePaytable(raw)
}

func decodePaytable(raw []byte) (rules.PaytableLines, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode paytable lines: %w", err)
	}
	out := make(rules.PaytableLines, len(m))
	for k, v := range m {
		if !rules.IsLineKey(k) {
			continue
		}
		// json.Number would accept a quoted "35"; a multiplier is a bare
		// integer or it is not a multiplier.
		n, err := strconv.ParseInt(string(v), 10, 64)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("paytable line %s: %s is not a non-negative integer", k, string(v))
		}
		out[rules.LineKey(k)] = int(n)
	}
	return out, nil
}
