package main

import (
	"testing"
	"time"
)

// Regression test for the backoff reset.
//
// Without a reset, backoff only had an initial value (1 s) and doubling. A few
// early failures would pin the process at the cap (30 s) for its whole
// lifetime, and with the server's 15 s freshness window the node looked
// degraded on every reconnect.
func TestNextBackoff(t *testing.T) {
	cases := []struct {
		name    string
		current time.Duration
		lasted  time.Duration
		want    time.Duration
	}{
		{"short session doubles", time.Second, time.Second, 2 * time.Second},
		{"repeated short sessions keep doubling", 4 * time.Second, 0, 8 * time.Second},
		{"never exceeds the cap", maxBackoff, 0, maxBackoff},
		{"does not exceed the cap just below it", 16 * time.Second, 0, maxBackoff},
		// The core of the fix: after a session that stayed up, start over.
		{"reset after a stable session", maxBackoff, sessionStableAfter, time.Second},
		{"reset after a longer session", maxBackoff, 10 * time.Minute, time.Second},
		// A connection that drops immediately must not earn a reset, or it
		// becomes a reconnect storm.
		{"no reset just below the threshold", maxBackoff, sessionStableAfter - time.Millisecond, maxBackoff},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := nextBackoff(c.current, c.lasted); got != c.want {
				t.Fatalf("nextBackoff(%v, %v) = %v, want %v", c.current, c.lasted, got, c.want)
			}
		})
	}
}

// The cap must stay below the server's grace period; if it were equal, a normal
// reconnect could exceed the grace period and be reported as missing. Whoever
// changes the values should find out here.
func TestBackoffCapBelowServerGrace(t *testing.T) {
	const serverGrace = 90 * time.Second
	if maxBackoff >= serverGrace {
		t.Fatalf("maxBackoff (%v) is not below the server grace period (%v); normal reconnects would look missing", maxBackoff, serverGrace)
	}
	// The reset threshold must be comfortably above the freshness window (15 s);
	// otherwise a session that never produced an observation could earn a reset.
	if sessionStableAfter <= 15*time.Second {
		t.Fatalf("sessionStableAfter (%v) is not above the freshness window (15s)", sessionStableAfter)
	}
}

// One full cycle: repeated failures, a stable session, then back to the start.
func TestBackoffRecoversAfterStableSession(t *testing.T) {
	b := time.Second
	for i := 0; i < 8; i++ {
		b = nextBackoff(b, 0) // keeps dropping quickly
	}
	if b != maxBackoff {
		t.Fatalf("after eight failures got %v, want %v", b, maxBackoff)
	}
	b = nextBackoff(b, sessionStableAfter) // stayed up once
	if b != time.Second {
		t.Fatalf("after a stable session got %v, want %v; the backoff does not reset", b, time.Second)
	}
}
