// Settlement worker: every interval, load closed Fonbet matches whose
// markets are still open, look them up in Fonbet's results feed, grade the
// markets we can (rules.go) and hand the results to services/settlement
// over the `settlement.external` stream. Cancelled results void the whole
// match. Everything the rules leave open stays open — an operator settles
// it by hand — and is counted in the cycle log line.

package settle

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/fonbet-ingester/internal/bus"
	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/specifiers"
	"github.com/oddzilla/fonbet-ingester/internal/store"
)

// Almaty is Fonbet KZ's line-day timezone.
var Almaty = time.FixedZone("Asia/Almaty", 5*3600)

type Worker struct {
	st       *store.Store
	bus      *bus.Bus
	client   *fonbet.Client
	index    *atomic.Pointer[fonbet.Index]
	log      zerolog.Logger
	lang     string
	lookback int // days

	// recently emitted market ids → when; avoids re-sending every cycle
	// while services/settlement is still applying (apply-once makes a
	// resend harmless, it is just noise).
	emitted map[int64]time.Time
}

func New(st *store.Store, b *bus.Bus, client *fonbet.Client, index *atomic.Pointer[fonbet.Index], lang string, log zerolog.Logger) *Worker {
	return &Worker{
		st: st, bus: b, client: client, index: index, lang: lang,
		lookback: 7,
		log:      log.With().Str("component", "settle").Logger(),
		emitted:  map[int64]time.Time{},
	}
}

// Stats summarises one pass.
type Stats struct {
	Pending, Matched, NoResult, NotFinished       int
	MarketsSettled, MarketsCancelled, MarketsOpen int
	Skipped                                       map[string]int
}

// Run loops until ctx is done.
func (w *Worker) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	w.pass(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.pass(ctx)
		}
	}
}

func (w *Worker) pass(ctx context.Context) {
	stats, err := w.RunOnce(ctx)
	if err != nil {
		w.log.Error().Err(err).Msg("settlement pass failed")
		return
	}
	if stats.Pending == 0 {
		return
	}
	ev := w.log.Info().Int("pending", stats.Pending).Int("matched", stats.Matched).
		Int("no_result", stats.NoResult).Int("not_finished", stats.NotFinished).
		Int("settled", stats.MarketsSettled).Int("cancelled", stats.MarketsCancelled).Int("left_open", stats.MarketsOpen)
	if len(stats.Skipped) > 0 {
		ev = ev.Interface("skipped", stats.Skipped)
	}
	ev.Msg("settlement pass")
}

// resultIndex groups one results document by (competition, start time).
type resultIndex struct {
	sports  map[int]int                  // competition id → sport id
	matches map[resultKey][]*resultMatch // main rows
}

type resultKey struct {
	competition int
	startTime   int64
}

type resultMatch struct {
	name   string // normalized "a – b"
	status int
	score  string
	stats  map[string]fonbet.Score
}

func buildResultIndex(docs []*fonbet.ResultsResponse) *resultIndex {
	ri := &resultIndex{sports: map[int]int{}, matches: map[resultKey][]*resultMatch{}}
	for _, doc := range docs {
		events := map[int64]*fonbet.ResultEvent{}
		for i := range doc.Events {
			id, _ := doc.Events[i].ID.Int64()
			events[id] = &doc.Events[i]
		}
		for _, sec := range doc.Sections {
			ri.sports[sec.FonbetCompetitionID] = sec.FonbetSportID
			var cur *resultMatch
			for _, id := range sec.Events {
				e := events[int64(id)]
				if e == nil {
					continue
				}
				if fonbet.IsMatchName(e.Name) {
					cur = &resultMatch{name: fonbet.NormalizeMatchName(e.Name), status: e.Status, score: e.Score, stats: map[string]fonbet.Score{}}
					k := resultKey{sec.FonbetCompetitionID, e.StartTime}
					ri.matches[k] = append(ri.matches[k], cur)
					continue
				}
				if cur == nil {
					continue
				}
				if sc, ok := fonbet.ParseScore(e.Score); ok {
					cur.stats[strings.ToLower(strings.TrimSpace(e.Name))] = sc
				}
			}
		}
	}
	return ri
}

func (ri *resultIndex) find(m store.PendingMatch) *resultMatch {
	want := fonbet.NormalizeMatchName(m.HomeTeam + " – " + m.AwayTeam)
	for _, rm := range ri.matches[resultKey{m.SegmentID, m.StartTime}] {
		if rm.name == want {
			return rm
		}
	}
	// Fallback: same competition + start time, both team names present AND
	// in home-then-away order. The exact match above has already failed
	// when we get here, and the most likely reason is that the two feeds
	// name or order the teams differently — so an order-blind substring
	// test would happily bind "Rubin – Orenburg" to home=Orenburg and grade
	// every 1X2 / handicap / team total on the match inverted. Requiring
	// home before away rejects the mirrored row; a genuinely reordered
	// fixture then stays pending for manual settlement, which is the
	// cheaper mistake.
	h, a := strings.ToLower(m.HomeTeam), strings.ToLower(m.AwayTeam)
	if h == "" || a == "" {
		return nil
	}
	for _, rm := range ri.matches[resultKey{m.SegmentID, m.StartTime}] {
		hi := strings.Index(rm.name, h)
		if hi < 0 {
			continue
		}
		if ai := strings.Index(rm.name[hi+len(h):], a); ai >= 0 {
			return rm
		}
	}
	return nil
}

// RunOnce performs one settlement pass.
func (w *Worker) RunOnce(ctx context.Context) (Stats, error) {
	stats := Stats{Skipped: map[string]int{}}
	idx := w.index.Load()
	if idx == nil {
		return stats, nil
	}
	pending, err := store.LoadPendingSettlement(ctx, w.st.Pool(), w.lookback)
	if err != nil {
		return stats, err
	}
	stats.Pending = len(pending)
	if len(pending) == 0 {
		return stats, nil
	}
	labels, err := store.LoadVariantLabels(ctx, w.st.Pool(), w.lang)
	if err != nil {
		return stats, err
	}

	// Results documents for every line day the pending matches touch (plus
	// the previous day: late kick-offs are filed under the day they started).
	days := map[string]struct{}{}
	for _, m := range pending {
		d := time.Unix(m.StartTime, 0).In(Almaty)
		days[d.Format("2006-01-02")] = struct{}{}
		days[d.AddDate(0, 0, -1).Format("2006-01-02")] = struct{}{}
	}
	var docs []*fonbet.ResultsResponse
	for d := range days {
		doc, err := w.client.FetchResults(ctx, d)
		if err != nil {
			w.log.Warn().Err(err).Str("date", d).Msg("results fetch failed")
			continue
		}
		docs = append(docs, doc)
	}
	if len(docs) == 0 {
		return stats, nil
	}
	ri := buildResultIndex(docs)

	now := time.Now()
	nowMs := now.UnixMilli()
	// msgs and marketIDs are parallel: marketIDs[i] is the market msgs[i]
	// settles, so the emitted stamp can be written per published chunk.
	var msgs []bus.SettlementMessage
	var marketIDs []int64
	for _, m := range pending {
		rm := ri.find(m)
		if rm == nil {
			stats.NoResult++
			continue
		}
		stats.Matched++
		if rm.status == fonbet.ResultCancelled {
			for _, mk := range m.Markets {
				if w.recentlyEmitted(mk.ID, now) {
					continue
				}
				msgs = append(msgs, bus.SettlementMessage{Type: "cancel", EventURN: m.URN, ProviderMarketID: mk.PMID,
					Specifiers: specifiers.Canonical(mk.Specs), Ts: nowMs})
				marketIDs = append(marketIDs, mk.ID)
				stats.MarketsCancelled++
			}
			continue
		}
		if rm.status != fonbet.ResultFinished {
			stats.NotFinished++
			continue
		}
		main, ok := fonbet.ParseScore(rm.score)
		if !ok {
			stats.Skipped["unparsable score"]++
			continue
		}
		ss := ScoreSet{Main: main, Stats: rm.stats}
		if ot, ok := rm.stats["дополнительное время"]; ok {
			ss.OT = &ot
		}
		for _, k := range []string{"серия пенальти", "серия буллитов"} {
			if sh, ok := rm.stats[k]; ok {
				ss.Shoot = &sh
			}
		}
		sport := ri.sports[m.SegmentID]
		for _, mk := range m.Markets {
			if w.recentlyEmitted(mk.ID, now) {
				continue
			}
			label := labels[mk.Specs["variant"]]
			if mk.Specs["variant"] != "" && label == "" {
				stats.Skipped["unknown sub-event"]++
				stats.MarketsOpen++
				continue
			}
			outs, ok, why := Grade(Market{PMID: mk.PMID, Specs: mk.Specs, OutcomeIDs: mk.OutcomeIDs}, idx, label, sport, ss)
			if !ok {
				stats.Skipped[why]++
				stats.MarketsOpen++
				continue
			}
			if len(outs) == 0 {
				// A market row with no outcomes grades to nothing; the
				// consumer drops an outcome-less settle, so sending it
				// would only mark the market emitted and hide it from the
				// log for an hour.
				stats.Skipped["no outcomes"]++
				stats.MarketsOpen++
				continue
			}
			payload, _ := json.Marshal(outs)
			msgs = append(msgs, bus.SettlementMessage{Type: "settle", EventURN: m.URN, ProviderMarketID: mk.PMID,
				Specifiers: specifiers.Canonical(mk.Specs), Ts: nowMs, OutcomesJSON: string(payload)})
			marketIDs = append(marketIDs, mk.ID)
			stats.MarketsSettled++
		}
	}
	// Publish in chunks and stamp `emitted` only for the chunk that made it
	// onto the stream. Stamping inside the grading loop (as the first cut
	// did) meant one failed XADD hid every market of the pass — published
	// or not — from the next hour of passes, so tickets sat open for an
	// hour after a transient Redis error.
	for i := 0; i < len(msgs); i += 500 {
		end := min(i+500, len(msgs))
		if err := w.bus.PublishSettlementBatch(ctx, msgs[i:end]); err != nil {
			unsent := len(msgs) - i
			stats.MarketsSettled -= min(unsent, stats.MarketsSettled)
			return stats, fmt.Errorf("publish settlements (%d of %d not sent, will retry next pass): %w", unsent, len(msgs), err)
		}
		for _, id := range marketIDs[i:end] {
			w.emitted[id] = now
		}
	}
	// Forget emissions older than an hour so a lost message is retried.
	for id, at := range w.emitted {
		if now.Sub(at) > time.Hour {
			delete(w.emitted, id)
		}
	}
	return stats, nil
}

func (w *Worker) recentlyEmitted(marketID int64, now time.Time) bool {
	at, ok := w.emitted[marketID]
	return ok && now.Sub(at) < time.Hour
}
