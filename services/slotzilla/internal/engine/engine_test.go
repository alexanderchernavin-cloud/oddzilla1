package engine

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/oddzilla/slotzilla/internal/rules"
	"github.com/oddzilla/slotzilla/internal/store"
)

var t0 = time.Date(2026, 9, 9, 19, 0, 0, 0, time.UTC)

func TestBuildWindowsDerivesReelsPerGrid(t *testing.T) {
	events := map[int64]Event{
		1: {ID: 1, Symbol: rules.MISS, Team: "away", Seconds: 101, SeenAt: t0},
		2: {ID: 2, Symbol: rules.P2, Team: "home", Seconds: 103, SeenAt: t0.Add(2 * time.Second)},
		3: {ID: 3, Symbol: rules.FOUL, Team: "away", Seconds: 104, SeenAt: t0.Add(time.Second)},
		4: {ID: 4, Symbol: "", Seconds: 107, SeenAt: t0.Add(9 * time.Second)},                // rebound: no symbol, still a correction clock
		5: {ID: 5, Symbol: rules.P3, Team: "home", Seconds: 112, Disabled: true, SeenAt: t0}, // disabled: never a reel
		6: {ID: 6, Symbol: rules.FT, Team: "away", Seconds: 114, SeenAt: t0},
	}
	ws := BuildWindows(events)
	if len(ws) != 3 {
		t.Fatalf("want 3 windows, got %d: %v", len(ws), ws)
	}
	w100 := ws[100]
	if w100.Reel.Symbol != rules.P2 || w100.Reel.Team != "home" || w100.Reel.EventID != "2" {
		t.Errorf("window 100: %+v", w100.Reel)
	}
	if !w100.LastUpdate.Equal(t0.Add(2 * time.Second)) {
		t.Errorf("window 100 last update: %v", w100.LastUpdate)
	}
	w105 := ws[105]
	if w105.Reel.Symbol != rules.NONE || w105.Reel.EventID != "" {
		t.Errorf("window 105 with only a rebound must be NONE: %+v", w105.Reel)
	}
	if !w105.LastUpdate.Equal(t0.Add(9 * time.Second)) {
		t.Errorf("a no-symbol event still moves the window's last update: %v", w105.LastUpdate)
	}
	w110 := ws[110]
	if w110.Reel.Symbol != rules.FT || w110.Reel.EventID != "6" {
		t.Errorf("window 110 must skip the disabled P3: %+v", w110.Reel)
	}
	if empty := WindowAt(ws, 95); empty.Reel.Symbol != rules.NONE || empty.From != 95 || !empty.LastUpdate.IsZero() {
		t.Errorf("absent window: %+v", empty)
	}
}

func TestWindowFinalPredicate(t *testing.T) {
	rule := FinalRule{ClockPastSeconds: 5, GraceSeconds: 10}
	w := Window{From: 100, Reel: rules.Reel{Symbol: rules.P2, EventID: "2"}, LastUpdate: t0}
	now := t0.Add(30 * time.Second)

	// Clock inside the window, just past it, and past it by clock_past.
	for clock, want := range map[int]bool{104: false, 105: false, 109: false, 110: true, 200: true} {
		if got := WindowFinal(w, clock, false, now, rule); got != want {
			t.Errorf("clock %d: want final=%v, got %v", clock, want, got)
		}
	}
	// Once the match has ended the clock will not move: clock_past drops
	// and a window the clock reached is final.
	if !WindowFinal(w, 105, true, now, rule) {
		t.Error("ended match: a reached window must be final")
	}
	if WindowFinal(w, 104, true, now, rule) {
		t.Error("ended match: an unreached window must not be final")
	}
	// Grace: the last event in the window arrived 3 s ago.
	if WindowFinal(w, 200, false, t0.Add(3*time.Second), rule) {
		t.Error("inside grace must not be final")
	}
	if !WindowFinal(w, 200, false, t0.Add(10*time.Second), rule) {
		t.Error("grace elapsed must be final")
	}
	// An empty window has nothing to wait on.
	empty := WindowAt(map[int]Window{}, 100)
	if !WindowFinal(empty, 110, false, t0, rule) {
		t.Error("empty window is final on the clock alone")
	}
	if WindowFinal(empty, 109, false, t0, rule) {
		t.Error("empty window still needs the clock past it")
	}
	// Zero knobs: final the second the clock leaves the window.
	if !WindowFinal(w, 105, false, t0, FinalRule{}) {
		t.Error("zero knobs")
	}
}

func TestOutcomeComposesSettlement(t *testing.T) {
	lines := rules.DefaultPaytableLines
	reels := [3]rules.Reel{
		{Symbol: rules.P2, Team: "home", EventID: "11"},
		{Symbol: rules.NONE},
		{Symbol: rules.P2, Team: "away", EventID: "12"},
	}
	st, err := Outcome(reels, lines, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if st.LineKey != "any2:P2" || st.MultiplierX100 != 1800 || st.PayoutMicro != 18_000_000 || st.Status != "won" {
		t.Errorf("any2:P2: %+v", st)
	}
	if st.EventIDs[0] == nil || *st.EventIDs[0] != 11 || st.EventIDs[1] != nil || st.EventIDs[2] == nil || *st.EventIDs[2] != 12 {
		t.Errorf("event ids: %v %v %v", st.EventIDs[0], st.EventIDs[1], st.EventIDs[2])
	}
	if st.Teams != [3]string{"home", "", "away"} {
		t.Errorf("teams: %v", st.Teams)
	}

	// Three different symbols: no line, nothing paid, lost.
	st, err = Outcome([3]rules.Reel{{Symbol: rules.P3}, {Symbol: rules.P2}, {Symbol: rules.FT}}, lines, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if st.LineKey != "" || st.MultiplierX100 != 0 || st.PayoutMicro != 0 || st.Status != "lost" {
		t.Errorf("no line: %+v", st)
	}

	// A line the spin's paytable does not carry pays nothing but is recorded.
	st, err = Outcome([3]rules.Reel{{Symbol: rules.FOUL}, {Symbol: rules.FOUL}, {Symbol: rules.NONE}}, rules.PaytableLines{"any2:P3": 3500}, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if st.LineKey != "any2:FOUL" || st.MultiplierX100 != 0 || st.PayoutMicro != 0 || st.Status != "lost" {
		t.Errorf("absent line: %+v", st)
	}

	// Half back on two NONE, floored to the micro.
	st, err = Outcome([3]rules.Reel{{Symbol: rules.NONE}, {Symbol: rules.MISS, EventID: "3"}, {Symbol: rules.NONE}}, lines, 333_333)
	if err != nil {
		t.Fatal(err)
	}
	if st.LineKey != "any2:NONE" || st.PayoutMicro != 166_666 || st.Status != "won" {
		t.Errorf("any2:NONE: %+v", st)
	}

	if _, err := Outcome([3]rules.Reel{{Symbol: rules.P2, EventID: "x"}, {Symbol: rules.NONE}, {Symbol: rules.NONE}}, lines, 1); err == nil {
		t.Error("a non-numeric event id must be an error")
	}
}

func TestRecentWindows(t *testing.T) {
	ws := map[int]Window{2300: {From: 2300, Reel: rules.Reel{Symbol: rules.P3, Team: "home", EventID: "9"}}}
	got := RecentWindows(ws, 2317)
	if len(got) != RecentWindowsCount {
		t.Fatalf("want %d windows, got %d", RecentWindowsCount, len(got))
	}
	if got[0].From != 2315-17*5 || got[len(got)-1].From != 2315 {
		t.Errorf("range: %d..%d", got[0].From, got[len(got)-1].From)
	}
	found := false
	for _, w := range got {
		if w.From == 2300 && w.Reel.Symbol == rules.P3 {
			found = true
		}
	}
	if !found {
		t.Error("stored window must appear in the recent list")
	}
	early := RecentWindows(ws, 12)
	if len(early) != 3 || early[0].From != 0 || early[2].From != 10 {
		t.Errorf("early clock must clamp at 0: %v", early)
	}
}

func TestFrameShapes(t *testing.T) {
	sp := store.Spin{ID: "s1", UserID: "u1", MatchID: 42, Currency: "OZ", StakeMicro: 1_000_000, WindowFrom: 2315, PlacedAt: t0}
	st := store.Settlement{
		Reels: [3]rules.Symbol{rules.P2, rules.NONE, rules.P2}, Teams: [3]string{"home", "", "away"},
		LineKey: "any2:P2", MultiplierX100: 1800, PayoutMicro: 18_000_000, Status: "won",
	}
	body, err := encodeSpinFrame(SettledSpinView(sp, st, t0.Add(time.Minute)), t0.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]any
	if err := json.Unmarshal(body, &f); err != nil {
		t.Fatal(err)
	}
	if f["type"] != "slotzilla_spin" {
		t.Errorf("type: %v", f["type"])
	}
	spin := f["spin"].(map[string]any)
	if spin["matchId"] != "42" || spin["stakeMicro"] != "1000000" || spin["payoutMicro"] != "18000000" || spin["status"] != "won" {
		t.Errorf("spin view: %v", spin)
	}
	if reels := spin["reels"].([]any); reels[0] != "P2" || reels[1] != "NONE" {
		t.Errorf("reels: %v", reels)
	}
	if teams := spin["reelTeams"].([]any); teams[0] != "home" || teams[1] != nil {
		t.Errorf("teams: %v", teams)
	}
	if wins := spin["windows"].([]any); wins[0] != 2315.0 || wins[2] != 2325.0 {
		t.Errorf("windows: %v", wins)
	}
	if spin["multiplierX100"] != 1800.0 || spin["lineKey"] != "any2:P2" || spin["voidReason"] != nil {
		t.Errorf("line: %v", spin)
	}

	body, err = encodeSpinFrame(VoidSpinView(sp, "feed_dark", t0), t0)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &f); err != nil {
		t.Fatal(err)
	}
	spin = f["spin"].(map[string]any)
	if spin["status"] != "void" || spin["voidReason"] != "feed_dark" || spin["payoutMicro"] != "0" {
		t.Errorf("void view: %v", spin)
	}
	if reels := spin["reels"].([]any); reels[0] != nil || reels[2] != nil {
		t.Errorf("void reels must be null: %v", reels)
	}

	w := windowToJSON(Window{From: 5, Reel: rules.Reel{Symbol: rules.NONE}}, true)
	if w.Team != nil || w.EventID != nil || !w.Final || w.Symbol != "NONE" {
		t.Errorf("window json: %+v", w)
	}
}
