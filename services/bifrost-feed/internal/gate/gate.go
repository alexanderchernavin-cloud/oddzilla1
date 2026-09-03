// Primary-feed liveness gate + operator source switch.
//
// Two inputs decide whether the backup may publish:
//
//  1. The operator's feed source, Redis `feed:source`, written by the
//     backoffice (PUT /admin/feed/source):
//       auto    → prod Oddin with automatic failover (default)
//       prod    → prod Oddin only; the backup never publishes
//       backup  → backup Oddin forced; publish regardless of AMQP
//     When the key is absent the env default BIFROST_MODE applies.
//
//  2. The primary liveness stamp, Redis `feed:primary:last_msg_unix`,
//     written by feed-ingester on every AMQP delivery. In auto mode the
//     backup publishes while the stamp is older than the takeover
//     threshold and stands down the moment it is fresh again.
//
// Forced backup waits for feed-ingester's flush acknowledgement
// (`feed:source:flushed_unix` at or after `feed:source:switched_unix`)
// before publishing, so the suspend of the AMQP-fed catalogue lands before
// the backup's full re-emit and cannot wipe it; a 15 s ceiling covers a
// feed-ingester that is itself down.
//
// Hysteresis in auto mode is deliberately asymmetric: taking over waits
// the full threshold so a routine reconnect blip never triggers a
// failover, but standing down is immediate because from the moment
// Oddin's AMQP is back, its OnConnect flush + 24 h replay is the
// authoritative state and two writers should overlap for as short a
// window as possible.

package gate

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/bifrost-feed/internal/config"
)

// Redis keys shared with feed-ingester (services/feed-ingester/cmd/
// feed-ingester/main.go) and the api (services/api/src/modules/admin/feed.ts).
const (
	PrimaryLivenessKey = "feed:primary:last_msg_unix"
	SourceKey          = "feed:source"
	SourceSwitchedKey  = "feed:source:switched_unix"
	SourceFlushedKey   = "feed:source:flushed_unix"
)

// Source values written by the backoffice.
const (
	SourceAuto   = "auto"
	SourceProd   = "prod"
	SourceBackup = "backup"
)

const (
	checkEvery = 2 * time.Second
	// flushWait caps how long forced-backup activation waits for
	// feed-ingester's flush acknowledgement.
	flushWait = 15 * time.Second
)

type Status struct {
	// Mode is the effective mode after applying the operator switch over
	// the env default: auto / active / off.
	Mode config.Mode `json:"mode"`
	// DefaultMode is the env default (BIFROST_MODE).
	DefaultMode config.Mode `json:"defaultMode"`
	// Source is the operator switch as read from Redis ("" when unset).
	Source               string     `json:"source,omitempty"`
	Active               bool       `json:"active"`
	WaitingForFlush      bool       `json:"waitingForFlush"`
	Since                time.Time  `json:"since"`
	PrimaryLastMessageAt *time.Time `json:"primaryLastMessageAt,omitempty"`
	PrimaryStaleSeconds  *int64     `json:"primaryStaleSeconds,omitempty"`
	TakeoverAfterSeconds int        `json:"takeoverAfterSeconds"`
	Transitions          int64      `json:"transitions"`
	LastRedisError       string     `json:"lastRedisError,omitempty"`
}

type Gate struct {
	rdb         *redis.Client
	defaultMode config.Mode
	threshold   time.Duration
	bootedAt    time.Time
	log         zerolog.Logger

	mu          sync.RWMutex
	mode        config.Mode
	source      string
	active      bool
	waiting     bool
	since       time.Time
	generation  uint64
	lastPrimary time.Time
	transitions int64
	lastErr     string
}

func New(rdb *redis.Client, defaultMode config.Mode, takeoverAfter time.Duration, log zerolog.Logger) *Gate {
	g := &Gate{
		rdb:         rdb,
		defaultMode: defaultMode,
		mode:        defaultMode,
		threshold:   takeoverAfter,
		bootedAt:    time.Now(),
		log:         log.With().Str("component", "gate").Logger(),
		since:       time.Now(),
	}
	if defaultMode == config.ModeActive {
		g.active = true
	}
	return g
}

// Run evaluates the gate until ctx ends.
func (g *Gate) Run(ctx context.Context) {
	t := time.NewTicker(checkEvery)
	defer t.Stop()
	g.evaluate(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.evaluate(ctx)
		}
	}
}

type inputs struct {
	primary  time.Time
	source   string
	switched time.Time
	flushed  time.Time
}

func (g *Gate) evaluate(ctx context.Context) {
	in, err := g.read(ctx)
	g.mu.Lock()
	defer g.mu.Unlock()
	if err != nil {
		g.lastErr = err.Error()
		// Redis unreachable: keep whatever we were doing. Flapping on a
		// Redis blip would be worse than either steady state, and the
		// publisher cannot reach Redis either, so nothing is lost.
		return
	}
	g.lastErr = ""
	g.lastPrimary = in.primary
	g.source = in.source

	mode := g.defaultMode
	switch in.source {
	case SourceAuto:
		mode = config.ModeAuto
	case SourceProd:
		mode = config.ModeOff
	case SourceBackup:
		mode = config.ModeActive
	}
	if mode != g.mode {
		g.log.Warn().Str("from", string(g.mode)).Str("to", string(mode)).Str("source", in.source).
			Msg("feed source switched")
		g.mode = mode
	}

	var want bool
	waiting := false
	switch mode {
	case config.ModeOff:
		want = false
	case config.ModeActive:
		// Forced: wait for feed-ingester to acknowledge its flush of the
		// AMQP-fed catalogue, so our full re-emit lands after it.
		if in.switched.IsZero() || !in.flushed.Before(in.switched) || time.Since(in.switched) > flushWait {
			want = true
		} else {
			waiting = true
		}
	default:
		var silence time.Duration
		if in.primary.IsZero() {
			// Never stamped since we booted (older feed-ingester, or it is
			// down): measure from our own boot so we still take over
			// eventually, but never in the first threshold window while
			// the stack is coming up.
			silence = time.Since(g.bootedAt)
		} else {
			silence = time.Since(in.primary)
		}
		want = silence >= g.threshold
		if want != g.active {
			if want {
				g.log.Warn().Dur("primary_silence", silence).Dur("threshold", g.threshold).
					Msg("primary feed silent past threshold; backup ACTIVE")
			} else {
				g.log.Warn().Dur("primary_silence", silence).
					Msg("primary feed resumed; backup standing down")
			}
		}
	}
	g.waiting = waiting
	if want != g.active {
		g.flip(want)
		if mode != config.ModeAuto {
			g.log.Warn().Bool("active", want).Str("mode", string(mode)).Msg("backup publishing state changed by operator switch")
		}
	}
}

func (g *Gate) flip(active bool) {
	g.active = active
	g.since = time.Now()
	g.generation++
	g.transitions++
}

func (g *Gate) read(ctx context.Context) (inputs, error) {
	var in inputs
	vals, err := g.rdb.MGet(ctx, PrimaryLivenessKey, SourceKey, SourceSwitchedKey, SourceFlushedKey).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return in, err
	}
	if len(vals) != 4 {
		return in, errors.New("mget returned unexpected arity")
	}
	in.primary = unixField(vals[0])
	if s, ok := vals[1].(string); ok {
		in.source = s
	}
	in.switched = unixField(vals[2])
	in.flushed = unixField(vals[3])
	return in, nil
}

func unixField(v any) time.Time {
	s, ok := v.(string)
	if !ok || s == "" {
		return time.Time{}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// Active reports whether the runner may publish right now.
func (g *Gate) Active() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.active
}

// Generation increments on every flip; the runner uses it to notice an
// activation and re-emit full snapshots of everything it tracks.
func (g *Gate) Generation() (bool, uint64) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.active, g.generation
}

func (g *Gate) Snapshot() Status {
	g.mu.RLock()
	defer g.mu.RUnlock()
	s := Status{
		Mode:                 g.mode,
		DefaultMode:          g.defaultMode,
		Source:               g.source,
		Active:               g.active,
		WaitingForFlush:      g.waiting,
		Since:                g.since,
		TakeoverAfterSeconds: int(g.threshold / time.Second),
		Transitions:          g.transitions,
		LastRedisError:       g.lastErr,
	}
	if !g.lastPrimary.IsZero() {
		lp := g.lastPrimary
		s.PrimaryLastMessageAt = &lp
		stale := int64(time.Since(lp) / time.Second)
		s.PrimaryStaleSeconds = &stale
	}
	return s
}
