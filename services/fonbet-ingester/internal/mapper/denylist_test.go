package mapper

import "testing"

func TestDenylistDenies(t *testing.T) {
	d := &Denylist{
		Tables:        map[int]struct{}{7800: {}, 4500: {}},
		LabelPrefixes: []string{"Player specials", "Special bets"},
	}
	cases := []struct {
		table int
		label string
		want  bool
	}{
		{7800, "", true},                            // point-winner table, main event
		{7800, "2nd set", true},                     // ... and under a sub-event
		{305, "", false},                           // an ordinary total
		{305, "Player specials. . Fam A", true},    // player prop under a sub-event label
		{120, "special bets kick \"50/22\"", true}, // prefix is case-insensitive
		{305, "1st half", false},                   // period labels are not specials
		{305, "Specials of the day player", false}, // prefix, not substring
	}
	for _, c := range cases {
		if got := d.Denies(c.table, c.label); got != c.want {
			t.Errorf("Denies(%d, %q) = %v, want %v", c.table, c.label, got, c.want)
		}
	}
	var nilList *Denylist
	if nilList.Denies(1007800, "") {
		t.Fatal("a nil denylist denies nothing")
	}
}
