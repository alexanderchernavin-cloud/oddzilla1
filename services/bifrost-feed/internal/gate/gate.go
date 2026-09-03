// Primary-feed liveness gate + operator source switch.
//
// Two inputs decide whether the backup may publish:
//
//  1. The operator's feed source, the singleton Postgres row
//     `feed_control` (migration 0095), written by the backoffice
//     (PUT /admin/feed/source):
//       auto    → prod Oddin with automatic failover (default)
//       prod    → prod Oddin only; the backup never publishes
//       backup  → backup Oddin forced; publish regardless of AMQP
//     When the row cannot be read the last known value is kept; when it
//     has never been set the env default BIFROST_MODE applies. It lived in
//     Redis for one day: production Redis is an allkeys-lru cache and
//     evicted the keys when this service's own stream filled it, silently
//     turning a forced Backup back into Auto (2026-09-03).
//
//  2. The primary liveness stamps written by feed-ingester to Redis:
//     `feed:primary:last_msg_unix` on every AMQP delivery, and
//     `feed:primary:connected_unix` every 2 s (15 s TTL, deleted on
//     disconnect) for as long as the AMQP connection is open. In auto
//     mode the primary counts as alive while EITHER is fresh; the backup
//     publishes once both have been stale past the takeover threshold
//     and stands down the moment one is fresh again. The connection
//     stamp exists because a restart leaves the connection open but
//     delivery-free for 60-100 s (flush + Oddin's replay ramp), which on
//     2026-09-03 triggered a 33 s takeover on a healthy feed; every real
//     outage the backup is for drops the connection. These stamps are
//     fine in Redis: they are refreshed every second or two, so losing
//     one costs a tick.
//
// Forced backup waits for feed-ingester's flush acknowledgement
// (`flushed_at` at or after `switched_at`) before publishing, so the
// suspend of the AMQP-fed catalogue lands before the backup's full
// re-emit and cannot wipe it; a 15 s ceiling covers a feed-ingester that
// is itself down. Because that flush can take longer than the ceiling
// (76 s measured), the runner also re-emits whenever a later flush
// acknowledgement appears while active (FlushMark).
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
// feed-ingester/main.go).
const (
	PrimaryLivenessKey  = "feed:primary:last_msg_unix"
	PrimaryConnectedKey = "feed:primary:connected_unix"
)

// Source values written by the backoffice into feed_control.source.
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
	// connectedFresh bounds how old the connection stamp may be and still
	// count; feed-ingester refreshes it every 2 s with a 15 s TTL, so a
	// live key is always inside this window and a missed refresh or two is
	// tolerated.
	connectedFresh = 20 * time.Second
)

// Control is the operator switch row as the gate needs it.
type Control struct {
	Source     string
	SwitchedAt time.Time
	FlushedAt  time.Time
}

// ControlReader reads feed_control. Implemented by dbstate.DB; the dry-run
// mode substitutes one that reports no switch.
type ControlReader interface {
	ReadControl(ctx context.Context) (Control, error)
}

type Status struct {
	// Mode is the effective mode after applying the operator switch over
	// the env default: auto / active / off.
	Mode config.Mode `json:"mode"`
	// DefaultMode is the env default (BIFROST_MODE).
	DefaultMode config.Mode `json:"defaultMode"`
	// Source is the operator switch as read from feed_control ("" when unset).
	Source               string     `json:"source,omitempty"`
	Active               bool       `json:"active"`
	WaitingForFlush      bool       `json:"waitingForFlush"`
	Since                time.Time  `json:"since"`
	PrimaryConnected     bool       `json:"primaryConnected"`
	PrimaryLastMessageAt *time.Time `json:"primaryLastMessageAt,omitempty"`
	PrimaryStaleSeconds  *int64     `json:"primaryStaleSeconds,omitempty"`
	FlushedAt            *time.Time `json:"flushedAt,omitempty"`
	TakeoverAfterSeconds int        `json:"takeoverAfterSeconds"`
	Transitions          int64      `json:"transitions"`
	LastRedisError       string     `json:"lastRedisError,omitempty"`
	LastControlError     string     `json:"lastControlError,omitempty"`
}

type Gate struct {
	rdb         *redis.Client
	ctl         ControlReader
	defaultMode config.Mode
	threshold   time.Duration
	bootedAt    time.Time
	log         zerolog.Logger

	mu            sync.RWMutex
	mode          config.Mode
	control       Control
	active        bool
	waiting       bool
	since         time.Time
	generation    uint64
	lastPrimary   time.Time
	lastConnected time.Time
	transitions   int64
	lastErr       string
	lastCtlErr    string
}

func New(rdb *redis.Client, ctl ControlReader, defaultMode config.Mode, takeoverAfter time.Duration, log zerolog.Logger) *Gate {
	g := &Gate{
		rdb:         rdb,
		ctl:         ctl,
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

func (g *Gate) evaluate(ctx context.Context) {
	primary, connected, redisErr := g.readLiveness(ctx)
	ctl, ctlErr := g.ctl.ReadControl(ctx)

	g.mu.Lock()
	defer g.mu.Unlock()

	if ctlErr != nil {
		// Keep the last known switch position; a transient DB error must
		// not flip the source.
		g.lastCtlErr = ctlErr.Error()
	} else {
		g.lastCtlErr = ""
		g.control = ctl
	}
	if redisErr != nil {
		g.lastErr = redisErr.Error()
	} else {
		g.lastErr = ""
		g.lastPrimary = primary
		g.lastConnected = connected
	}

	mode := g.defaultMode
	switch g.control.Source {
	case SourceAuto:
		mode = config.ModeAuto
	case SourceProd:
		mode = config.ModeOff
	case SourceBackup:
		mode = config.ModeActive
	}
	if mode != g.mode {
		g.log.Warn().Str("from", string(g.mode)).Str("to", string(mode)).Str("source", g.control.Source).
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
		sw, fl := g.control.SwitchedAt, g.control.FlushedAt
		if sw.IsZero() || (!fl.IsZero() && !fl.Before(sw)) || time.Since(sw) > flushWait {
			want = true
		} else {
			waiting = true
		}
	default:
		if redisErr != nil {
			// Redis unreachable: keep whatever we were doing. Flapping on a
			// Redis blip would be worse than either steady state, and the
			// publisher cannot reach Redis either, so nothing is lost.
			g.waiting = false
			return
		}
		var silence time.Duration
		if g.lastPrimary.IsZero() {
			// Never stamped since we booted (older feed-ingester, or it is
			// down): measure from our own boot so we still take over
			// eventually, but never in the first threshold window while
			// the stack is coming up.
			silence = time.Since(g.bootedAt)
		} else {
			silence = time.Since(g.lastPrimary)
		}
		// An open AMQP connection is proof of life even with no deliveries
		// yet (post-restart flush + replay ramp); the outages the backup
		// exists for all drop the connection.
		if !g.lastConnected.IsZero() && time.Since(g.lastConnected) < connectedFresh {
			silence = 0
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

func (g *Gate) readLiveness(ctx context.Context) (primary, connected time.Time, err error) {
	if g.rdb == nil {
		return time.Time{}, time.Time{}, nil
	}
	vals, err := g.rdb.MGet(ctx, PrimaryLivenessKey, PrimaryConnectedKey).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return time.Time{}, time.Time{}, err
	}
	if len(vals) != 2 {
		return time.Time{}, time.Time{}, errors.New("mget returned unexpected arity")
	}
	return unixField(vals[0]), unixField(vals[1]), nil
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

// FlushMark is feed-ingester's latest flush acknowledgement. The runner
// re-emits when it moves while active: a flush that completes after the
// 15 s activation ceiling has just suspended everything the backup fed.
func (g *Gate) FlushMark() time.Time {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.control.FlushedAt
}

func (g *Gate) Snapshot() Status {
	g.mu.RLock()
	defer g.mu.RUnlock()
	s := Status{
		Mode:                 g.mode,
		DefaultMode:          g.defaultMode,
		Source:               g.control.Source,
		Active:               g.active,
		WaitingForFlush:      g.waiting,
		Since:                g.since,
		TakeoverAfterSeconds: int(g.threshold / time.Second),
		Transitions:          g.transitions,
		LastRedisError:       g.lastErr,
		LastControlError:     g.lastCtlErr,
		PrimaryConnected:     !g.lastConnected.IsZero() && time.Since(g.lastConnected) < connectedFresh,
	}
	if !g.lastPrimary.IsZero() {
		lp := g.lastPrimary
		s.PrimaryLastMessageAt = &lp
		stale := int64(time.Since(lp) / time.Second)
		s.PrimaryStaleSeconds = &stale
	}
	if !g.control.FlushedAt.IsZero() {
		fa := g.control.FlushedAt
		s.FlushedAt = &fa
	}
	return s
}
