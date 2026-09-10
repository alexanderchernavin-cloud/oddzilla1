// Wire shapes: the JSON of the two frames the service publishes. They
// mirror WsSlotzillaState / WsSlotzillaSpin / SlotzillaSpinView in
// packages/types/src/slotzilla.ts field for field; bigints travel as
// decimal strings and ids as strings, per the repo's JSON convention.

package engine

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/oddzilla/slotzilla/internal/rules"
	"github.com/oddzilla/slotzilla/internal/store"
)

type clockJSON struct {
	Seconds *int  `json:"seconds"`
	Running bool  `json:"running"`
	AtMs    int64 `json:"atMs"`
	Period  *int  `json:"period"`
}

type windowJSON struct {
	From    int     `json:"from"`
	Symbol  string  `json:"symbol"`
	Team    *string `json:"team"`
	EventID *string `json:"eventId"`
	Final   bool    `json:"final"`
}

type stateFrame struct {
	Type    string       `json:"type"`
	MatchID string       `json:"matchId"`
	Status  string       `json:"status"`
	Clock   clockJSON    `json:"clock"`
	Windows []windowJSON `json:"windows"`
	Ts      int64        `json:"ts"`
}

func windowToJSON(w Window, final bool) windowJSON {
	out := windowJSON{From: w.From, Symbol: string(w.Reel.Symbol), Final: final}
	if w.Reel.Team != "" {
		t := w.Reel.Team
		out.Team = &t
	}
	if w.Reel.EventID != "" {
		id := w.Reel.EventID
		out.EventID = &id
	}
	return out
}

// SpinView is SlotzillaSpinView.
type SpinView struct {
	ID             string     `json:"id"`
	MatchID        string     `json:"matchId"`
	Currency       string     `json:"currency"`
	StakeMicro     string     `json:"stakeMicro"`
	WindowFrom     int        `json:"windowFrom"`
	Windows        [3]int     `json:"windows"`
	Reels          [3]*string `json:"reels"`
	ReelTeams      [3]*string `json:"reelTeams"`
	LineKey        *string    `json:"lineKey"`
	MultiplierX100 *int       `json:"multiplierX100"`
	PayoutMicro    string     `json:"payoutMicro"`
	Status         string     `json:"status"`
	VoidReason     *string    `json:"voidReason"`
	PlacedAt       string     `json:"placedAt"`
	SettledAt      *string    `json:"settledAt"`
}

type spinFrame struct {
	Type string   `json:"type"`
	Spin SpinView `json:"spin"`
	Ts   int64    `json:"ts"`
}

func baseSpinView(sp store.Spin) SpinView {
	return SpinView{
		ID:          sp.ID,
		MatchID:     strconv.FormatInt(sp.MatchID, 10),
		Currency:    sp.Currency,
		StakeMicro:  strconv.FormatInt(sp.StakeMicro, 10),
		WindowFrom:  sp.WindowFrom,
		Windows:     rules.RoundWindowsOf(sp.WindowFrom),
		PayoutMicro: "0",
		Status:      "open",
		PlacedAt:    sp.PlacedAt.UTC().Format(time.RFC3339),
	}
}

// SettledSpinView is the frame body after a settlement.
func SettledSpinView(sp store.Spin, st store.Settlement, settledAt time.Time) SpinView {
	v := baseSpinView(sp)
	for i := range st.Reels {
		s := string(st.Reels[i])
		v.Reels[i] = &s
		if st.Teams[i] != "" {
			t := st.Teams[i]
			v.ReelTeams[i] = &t
		}
	}
	if st.LineKey != "" {
		k := st.LineKey
		v.LineKey = &k
		m := st.MultiplierX100
		v.MultiplierX100 = &m
	}
	v.PayoutMicro = strconv.FormatInt(st.PayoutMicro, 10)
	v.Status = st.Status
	at := settledAt.UTC().Format(time.RFC3339)
	v.SettledAt = &at
	return v
}

// VoidSpinView is the frame body after a void.
func VoidSpinView(sp store.Spin, reason string, voidedAt time.Time) SpinView {
	v := baseSpinView(sp)
	v.Status = "void"
	v.VoidReason = &reason
	at := voidedAt.UTC().Format(time.RFC3339)
	v.SettledAt = &at
	return v
}

func encodeSpinFrame(v SpinView, now time.Time) ([]byte, error) {
	return json.Marshal(spinFrame{Type: "slotzilla_spin", Spin: v, Ts: now.UnixMilli()})
}
