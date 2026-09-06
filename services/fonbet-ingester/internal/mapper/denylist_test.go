package mapper

import "testing"

func TestDenylistDenies(t *testing.T) {
	d := &Denylist{
		Tables:        map[int]struct{}{1007800: {}, 1004500: {}},
		LabelPrefixes: []string{"Player specials", "Special bets"},
	}
	cases := []struct {
		pmid  int
		label string
		want  bool
	}{
		{1007800, "", true},                            // point-winner table, main event
		{1007800, "2nd set", true},                     // ... and under a sub-event
		{1000305, "", false},                           // an ordinary total
		{1000305, "Player specials. . Fam A", true},    // player prop under a sub-event label
		{1000120, "special bets kick \"50/22\"", true}, // prefix is case-insensitive
		{1000305, "1st half", false},                   // period labels are not specials
		{1000305, "Specials of the day player", false}, // prefix, not substring
	}
	for _, c := range cases {
		if got := d.Denies(c.pmid, c.label); got != c.want {
			t.Errorf("Denies(%d, %q) = %v, want %v", c.pmid, c.label, got, c.want)
		}
	}
	var nilList *Denylist
	if nilList.Denies(1007800, "") {
		t.Fatal("a nil denylist denies nothing")
	}
}
