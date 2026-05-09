package dockerstat

import "testing"

func TestParseHealth(t *testing.T) {
	cases := []struct {
		status string
		want   string
	}{
		{"Up 2 hours (healthy)", "healthy"},
		{"Up About a minute (unhealthy)", "unhealthy"},
		{"Up Less than a second (health: starting)", "starting"},
		{"Up 38 hours", "none"},
		{"Restarting (1) 5 seconds ago", "none"},
		{"", "none"},
	}
	for _, c := range cases {
		got := parseHealth(c.status)
		if got != c.want {
			t.Errorf("parseHealth(%q) = %q, want %q", c.status, got, c.want)
		}
	}
}

func TestPickName(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"/oddzilla-postgres-1"}, "oddzilla-postgres-1"},
		{[]string{"/api"}, "api"},
		{[]string{}, ""},
		{nil, ""},
	}
	for _, c := range cases {
		got := pickName(c.in)
		if got != c.want {
			t.Errorf("pickName(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTrimImageDigest(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"postgres:16-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50", "postgres:16-alpine"},
		{"caddy:2-alpine", "caddy:2-alpine"},
		{"redis:7-alpine@sha256:abc", "redis:7-alpine"},
		{"", ""},
	}
	for _, c := range cases {
		got := trimImageDigest(c.in)
		if got != c.want {
			t.Errorf("trimImageDigest(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
