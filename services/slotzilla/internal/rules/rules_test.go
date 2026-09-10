package rules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// goldenPath is docs/fixtures/slotzilla-rules.json relative to this
// package: the same table packages/types/src/slotzilla.test.ts reads.
const goldenPath = "../../../../docs/fixtures/slotzilla-rules.json"

type golden struct {
	Symbols []struct {
		Type   string  `json:"type"`
		Points *int    `json:"points"`
		Symbol *string `json:"symbol"`
	} `json:"symbols"`
	FirstWindow []struct {
		Clock int `json:"clock"`
		Lead  int `json:"lead"`
		First int `json:"first"`
	} `json:"firstWindow"`
	Reels []struct {
		Name       string `json:"name"`
		WindowFrom int    `json:"windowFrom"`
		Events     []struct {
			Symbol   *string `json:"symbol"`
			Seconds  int     `json:"seconds"`
			Team     string  `json:"team"`
			EventID  string  `json:"eventId"`
			Disabled bool    `json:"disabled"`
		} `json:"events"`
		Expect struct {
			Symbol  string  `json:"symbol"`
			Team    *string `json:"team"`
			EventID *string `json:"eventId"`
		} `json:"expect"`
	} `json:"reels"`
	Lines []struct {
		Reels [3]string `json:"reels"`
		Line  *string   `json:"line"`
	} `json:"lines"`
	Payouts []struct {
		StakeMicro     string `json:"stakeMicro"`
		MultiplierX100 int    `json:"multiplierX100"`
		PayoutMicro    string `json:"payoutMicro"`
	} `json:"payouts"`
	DefaultPaytable map[string]int `json:"defaultPaytable"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(goldenPath))
	if err != nil {
		t.Fatalf("read golden fixture: %v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("decode golden fixture: %v", err)
	}
	if len(g.Symbols) == 0 || len(g.FirstWindow) == 0 || len(g.Reels) == 0 || len(g.Lines) == 0 || len(g.Payouts) == 0 || len(g.DefaultPaytable) == 0 {
		t.Fatalf("golden fixture is missing a section: %+v", g)
	}
	return g
}

func TestGoldenSymbols(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Symbols {
		got, ok := SymbolForEvent(c.Type, c.Points)
		if c.Symbol == nil {
			if ok {
				t.Errorf("symbolForEvent(%s, %v): want none, got %s", c.Type, ptrInt(c.Points), got)
			}
			continue
		}
		if !ok || string(got) != *c.Symbol {
			t.Errorf("symbolForEvent(%s, %v): want %s, got %q ok=%v", c.Type, ptrInt(c.Points), *c.Symbol, got, ok)
		}
	}
}

func TestGoldenFirstWindow(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.FirstWindow {
		if got := FirstWindowFor(c.Clock, c.Lead); got != c.First {
			t.Errorf("firstWindowFor(%d, %d): want %d, got %d", c.Clock, c.Lead, c.First, got)
		}
	}
}

func TestGoldenReels(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Reels {
		events := make([]ReelEvent, 0, len(c.Events))
		for _, e := range c.Events {
			ev := ReelEvent{Seconds: e.Seconds, Team: e.Team, EventID: e.EventID, Disabled: e.Disabled}
			if e.Symbol != nil {
				ev.Symbol = Symbol(*e.Symbol)
			}
			events = append(events, ev)
		}
		got := ReelForWindow(events, c.WindowFrom)
		wantTeam := ""
		if c.Expect.Team != nil {
			wantTeam = *c.Expect.Team
		}
		wantID := ""
		if c.Expect.EventID != nil {
			wantID = *c.Expect.EventID
		}
		if string(got.Symbol) != c.Expect.Symbol || got.Team != wantTeam || got.EventID != wantID {
			t.Errorf("%s: want {%s %q %q}, got {%s %q %q}", c.Name, c.Expect.Symbol, wantTeam, wantID, got.Symbol, got.Team, got.EventID)
		}
	}
}

func TestGoldenLines(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Lines {
		reels := [3]Symbol{Symbol(c.Reels[0]), Symbol(c.Reels[1]), Symbol(c.Reels[2])}
		got, ok := EvaluateLine(reels)
		if c.Line == nil {
			if ok {
				t.Errorf("evaluateLine(%v): want no line, got %s", c.Reels, got)
			}
			continue
		}
		if !ok || string(got) != *c.Line {
			t.Errorf("evaluateLine(%v): want %s, got %q ok=%v", c.Reels, *c.Line, got, ok)
		}
	}
}

func TestGoldenPayouts(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Payouts {
		stake, err := strconv.ParseInt(c.StakeMicro, 10, 64)
		if err != nil {
			t.Fatalf("fixture stake %q: %v", c.StakeMicro, err)
		}
		got, err := PayoutMicro(stake, c.MultiplierX100)
		if err != nil {
			t.Fatalf("payoutMicro(%d, %d): %v", stake, c.MultiplierX100, err)
		}
		if strconv.FormatInt(got, 10) != c.PayoutMicro {
			t.Errorf("payoutMicro(%d, %d): want %s, got %d", stake, c.MultiplierX100, c.PayoutMicro, got)
		}
	}
}

func TestGoldenDefaultPaytable(t *testing.T) {
	g := loadGolden(t)
	if len(DefaultPaytableLines) != len(g.DefaultPaytable) {
		t.Fatalf("default paytable has %d lines, fixture %d", len(DefaultPaytableLines), len(g.DefaultPaytable))
	}
	for k, want := range g.DefaultPaytable {
		if !IsLineKey(k) {
			t.Errorf("fixture line %q is not a line key", k)
		}
		if got, ok := DefaultPaytableLines[LineKey(k)]; !ok || got != want {
			t.Errorf("default paytable %s: want %d, got %d (present=%v)", k, want, got, ok)
		}
	}
}

func TestLineKeysAndFormat(t *testing.T) {
	if len(LineKeys) != 12 {
		t.Fatalf("want 12 line keys, got %d", len(LineKeys))
	}
	if LineKeys[0] != "all3:P3" || LineKeys[1] != "any2:P3" || LineKeys[11] != "any2:NONE" {
		t.Errorf("line key order: %v", LineKeys)
	}
	if IsLineKey("any2:XX") || !IsLineKey("all3:FOUL") {
		t.Error("isLineKey")
	}
	for x100, want := range map[int]string{50: "0.5", 100: "1", 3500: "35", 1825: "18.25", 5: "0.05", 1250: "12.5"} {
		if got := FormatMultiplier(x100); got != want {
			t.Errorf("formatMultiplier(%d): want %s, got %s", x100, want, got)
		}
	}
	if got := FormatMatchClock(2315); got != "38:35" {
		t.Errorf("formatMatchClock: %s", got)
	}
	if got := FormatWindowLabel(2315); got != "38:35–38:39" {
		t.Errorf("formatWindowLabel: %s", got)
	}
	if got := FormatMatchClock(-3); got != "0:00" {
		t.Errorf("formatMatchClock(-3): %s", got)
	}
}

func TestWindowsAndExposure(t *testing.T) {
	if WindowStartOf(2317) != 2315 || WindowStartOf(2315) != 2315 || WindowStartOf(0) != 0 {
		t.Error("windowStartOf")
	}
	if w := RoundWindowsOf(100); w != [3]int{100, 105, 110} {
		t.Errorf("roundWindows: %v", w)
	}
	if RoundEnd(100) != 115 {
		t.Error("roundEnd")
	}
	if MaxMultiplierX100(DefaultPaytableLines) != 50000 {
		t.Error("maxMultiplier")
	}
	exp, err := ExposureMicro(1_000_000, DefaultPaytableLines, 500_000_000)
	if err != nil || exp != 500_000_000 {
		t.Errorf("exposure capped: %d %v", exp, err)
	}
	exp, err = ExposureMicro(100_000, DefaultPaytableLines, 500_000_000)
	if err != nil || exp != 50_000_000 {
		t.Errorf("exposure uncapped: %d %v", exp, err)
	}
	if _, err := PayoutMicro(1, -1); err == nil {
		t.Error("negative multiplier must be refused")
	}
	reels := ReelsForRound([]ReelEvent{{Symbol: P2, Seconds: 101, EventID: "1"}, {Symbol: FOUL, Seconds: 112, EventID: "2"}}, 100)
	if reels[0].Symbol != P2 || reels[1].Symbol != NONE || reels[2].Symbol != FOUL {
		t.Errorf("reelsForRound: %+v", reels)
	}
}

func ptrInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}
