package sweeper

import (
	"testing"
	"time"
)

func TestConfigDefaults(t *testing.T) {
	cases := []struct {
		name string
		in   Config
		want Config
	}{
		{
			name: "all zero → defaults",
			in:   Config{},
			want: Config{
				RecoveryAgeHours: DefaultRecoveryAgeHours,
				VoidAgeHours:     DefaultVoidAgeHours,
				Interval:         DefaultInterval,
			},
		},
		{
			name: "explicit values preserved",
			in: Config{
				RecoveryAgeHours: 1,
				VoidAgeHours:     12,
				Interval:         5 * time.Minute,
			},
			want: Config{
				RecoveryAgeHours: 1,
				VoidAgeHours:     12,
				Interval:         5 * time.Minute,
			},
		},
		{
			name: "void age below recovery age falls back to default",
			in: Config{
				RecoveryAgeHours: 6,
				VoidAgeHours:     3,
			},
			want: Config{
				RecoveryAgeHours: 6,
				VoidAgeHours:     DefaultVoidAgeHours,
				Interval:         DefaultInterval,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.in.withDefaults()
			if got != tc.want {
				t.Fatalf("withDefaults() = %+v, want %+v", got, tc.want)
			}
		})
	}
}
