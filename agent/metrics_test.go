package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// Regression tests for the metrics schedule. They run the real session loop
// (runLoop) against a fake clock.
//
// Contract (metricsSched): collections start on a fixed 60 s grid that is kept
// across sessions. If the scheduled time passed during a disconnect, collect
// immediately on reconnect and use that moment as the new base. If a
// collection runs past the next slot, missed slots are skipped rather than
// sent in a burst.
//
// How the fake clock advances: when runLoop calls after(d), the deadline is
// handed to the test as an armedTimer. The test moves the clock to the
// deadline and fires the channel, and the loop's select really calls
// sendMetrics. The next armedTimer only arrives after the send finishes, so the
// order is deterministic.

var t0 = time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)

type armedTimer struct {
	at time.Time
	ch chan time.Time
}

type fakeEnv struct {
	mu       sync.Mutex
	now      time.Time
	collect  time.Duration   // default collection time (df, systemctl)
	collects []time.Duration // if set, consumed from the front first
	starts   []time.Time     // collection start times
	sends    []time.Time     // send completion times
	armed    chan armedTimer
	created  int
	stopped  int
	sendErr  error
}

func newFakeEnv(collect time.Duration) *fakeEnv {
	return &fakeEnv{now: t0, collect: collect, armed: make(chan armedTimer, 1)}
}

func (f *fakeEnv) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeEnv) set(t time.Time) {
	f.mu.Lock()
	f.now = t
	f.mu.Unlock()
}

func (f *fakeEnv) after(d time.Duration) (<-chan time.Time, func()) {
	f.mu.Lock()
	at := f.now.Add(d)
	f.created++
	f.mu.Unlock()
	ch := make(chan time.Time, 1)
	f.armed <- armedTimer{at: at, ch: ch}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			f.mu.Lock()
			f.stopped++
			f.mu.Unlock()
		})
	}
}

func (f *fakeEnv) sendMetrics() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return f.sendErr
	}
	f.starts = append(f.starts, f.now)
	c := f.collect
	if len(f.collects) > 0 {
		c, f.collects = f.collects[0], f.collects[1:]
	}
	f.now = f.now.Add(c)
	f.sends = append(f.sends, f.now)
	return nil
}

type liveSession struct {
	t       *testing.T
	f       *fakeEnv
	readErr chan error
	done    chan error
}

func startSession(t *testing.T, f *fakeEnv, ms *metricsSched) *liveSession {
	t.Helper()
	s := &liveSession{t: t, f: f, readErr: make(chan error, 1), done: make(chan error, 1)}
	go func() {
		s.done <- runLoop(context.Background(), loopDeps{
			now:         f.clock,
			after:       f.after,
			beat:        nil, // beats are not under test here
			readErr:     s.readErr,
			sendBeat:    func(int64) error { return nil },
			sendMetrics: f.sendMetrics,
			closeNormal: func() {},
		}, ms)
	}()
	return s
}

// nextTimer receives the next metrics timer the loop arms. If none arrives
// (the loop never reached the metrics branch) the test fails; a real-time
// limit keeps a stalled loop from passing.
func (s *liveSession) nextTimer() armedTimer {
	s.t.Helper()
	select {
	case a := <-s.f.armed:
		return a
	case err := <-s.done:
		s.t.Fatalf("session ended before arming a timer: %v", err)
	case <-time.After(2 * time.Second):
		s.t.Fatalf("metrics timer was not re-armed; the session loop is not reaching the metrics branch")
	}
	return armedTimer{}
}

// fire fires timer a and returns the timer the loop re-arms after the send.
// Waiting for that next timer is the point: disconnecting without waiting
// would let select pick readErr or metrics at random, making results flaky.
func (s *liveSession) fire(a armedTimer) armedTimer {
	s.t.Helper()
	s.fireOnly(a)
	return s.nextTimer()
}

func (s *liveSession) fireOnly(a armedTimer) {
	s.f.set(a.at)
	a.ch <- a.at
}

// disconnect ends the session as if the connection dropped at time at (the
// armed timer does not fire).
func (s *liveSession) disconnect(at time.Time) {
	s.t.Helper()
	s.f.set(at)
	s.readErr <- errors.New("conn reset")
	select {
	case err := <-s.done:
		if err == nil || !strings.Contains(err.Error(), "read") {
			s.t.Fatalf("session ended with err = %v, want a read error", err)
		}
	case <-time.After(2 * time.Second):
		s.t.Fatalf("session does not end")
	}
}

func sec(n int) time.Duration { return time.Duration(n) * time.Second }

func rel(ts []time.Time) []time.Duration {
	out := make([]time.Duration, len(ts))
	for i, x := range ts {
		out[i] = x.Sub(t0)
	}
	return out
}

func equalDur(t *testing.T, what string, got []time.Time, want []time.Duration) {
	t.Helper()
	g := rel(got)
	if len(g) != len(want) {
		t.Fatalf("%s = %v, want %v", what, g, want)
	}
	for i := range want {
		if g[i] != want[i] {
			t.Fatalf("%s = %v, want %v", what, g, want)
		}
	}
}

func startGapsAtLeast(t *testing.T, starts []time.Time) {
	t.Helper()
	for i := 1; i < len(starts); i++ {
		if g := starts[i].Sub(starts[i-1]); g < metricsInterval {
			t.Fatalf("collection starts %d->%d are %v apart, less than %v; two samples would land in the same minute (starts=%v)", i-1, i, g, metricsInterval, rel(starts))
		}
	}
}

func timersBalanced(t *testing.T, f *fakeEnv) {
	t.Helper()
	if f.stopped != f.created {
		t.Fatalf("armed %d timers but stopped only %d", f.created, f.stopped)
	}
}

// The first session collects immediately.
func TestMetricsFirstSessionImmediate(t *testing.T) {
	f := newFakeEnv(0)
	s := startSession(t, f, &metricsSched{})
	a := s.nextTimer()
	if !a.at.Equal(t0) {
		t.Fatalf("first collection of the first session at +%v; want immediate", a.at.Sub(t0))
	}
	next := s.fire(a)
	s.disconnect(next.at.Add(-time.Second))
	timersBalanced(t, f)
}

// Within one session, collection time does not shift the schedule. Even with a
// 2 s collection, starts are [0, 60, 120, 180].
func TestMetricsFixedSlotsWithinSession(t *testing.T) {
	if metricsInterval != 60*time.Second {
		t.Fatalf("metricsInterval = %v, want 60s (paired with the server's 1440 expected samples per day)", metricsInterval)
	}
	f := newFakeEnv(sec(2))
	s := startSession(t, f, &metricsSched{})
	a := s.nextTimer()
	for i := 0; i < 4; i++ {
		a = s.fire(a)
	}
	s.disconnect(a.at.Add(-time.Second))
	equalDur(t, "starts", f.starts, []time.Duration{0, sec(60), sec(120), sec(180)})
	equalDur(t, "sends", f.sends, []time.Duration{sec(2), sec(62), sec(122), sec(182)})
	timersBalanced(t, f)
}

// Sample count over a long healthy connection: 1440 collection starts (plus or
// minus 1) in 24 hours, with 2 s and 7 s collections. Rescheduling at
// "finished + 60 s" would give about 1394 at 2 s and about 1290 at 7 s.
func TestMetricsDailyCountMatchesServerExpectation(t *testing.T) {
	const expected = 1440 // the server's expected samples per day
	for _, collect := range []time.Duration{sec(2), sec(7)} {
		f := newFakeEnv(collect)
		s := startSession(t, f, &metricsSched{})
		end := t0.Add(24 * time.Hour)
		a := s.nextTimer()
		for a.at.Before(end) {
			a = s.fire(a)
		}
		s.disconnect(end)
		n := 0
		for _, st := range f.starts {
			if !st.Before(t0) && st.Before(end) {
				n++
			}
		}
		if n < expected-1 || n > expected+1 {
			t.Fatalf("collect=%v: %d collections in 24h, want %d+/-1; collection time is accumulating into the schedule", collect, n, expected)
		}
		startGapsAtLeast(t, f.starts)
	}
}

// If one collection takes 70 s, the missed slot (120) is skipped rather than
// sent late, and the next collection is at the following slot (180).
func TestMetricsLongCollectSkipsMissedSlot(t *testing.T) {
	f := newFakeEnv(0)
	f.collects = []time.Duration{0, sec(70)} // the second collection (starting at +60) ends at +130
	s := startSession(t, f, &metricsSched{})
	a := s.fire(s.nextTimer()) // +0
	a = s.fire(a)              // +60, finishes at +130
	if want := t0.Add(sec(180)); !a.at.Equal(want) {
		t.Fatalf("after a 70s collection the next one is at +%v, want +%v (missed slots are skipped)", a.at.Sub(t0), want.Sub(t0))
	}
	a = s.fire(a)
	s.disconnect(a.at.Add(-time.Second))
	equalDur(t, "starts", f.starts, []time.Duration{0, sec(60), sec(180)})
	timersBalanced(t, f)
}

// Disconnect 5 s after a sample, reconnect at 7 s: wait for the original slot
// (+60). No two samples in the same minute.
func TestMetricsReconnectSoonKeepsSchedule(t *testing.T) {
	f := newFakeEnv(0)
	ms := &metricsSched{}
	s := startSession(t, f, ms)
	s.fire(s.nextTimer()) // +0, next at +60
	s.disconnect(t0.Add(sec(5)))

	f.set(t0.Add(sec(7)))
	s = startSession(t, f, ms)
	a := s.nextTimer()
	if want := t0.Add(sec(60)); !a.at.Equal(want) {
		t.Fatalf("first collection after reconnect at +%v, want +%v (original schedule)", a.at.Sub(t0), want.Sub(t0))
	}
	a = s.fire(a)
	if want := t0.Add(sec(120)); !a.at.Equal(want) {
		t.Fatalf("next collection at +%v, want +%v", a.at.Sub(t0), want.Sub(t0))
	}
	s.disconnect(a.at.Add(-time.Second))
	equalDur(t, "starts", f.starts, []time.Duration{0, sec(60)})
	timersBalanced(t, f)
}

// Repeated short sessions (10 s) with waits around the backoff cap (30 to
// 45 s): collection starts stay at least 60 s apart, and samples do not starve.
func TestMetricsFlappingSessionsKeepSpacing(t *testing.T) {
	f := newFakeEnv(sec(1))
	ms := &metricsSched{}
	cur := t0
	for _, b := range []int{30, 45, 38, 30, 45, 41, 30, 45} {
		f.set(cur)
		s := startSession(t, f, ms)
		end := cur.Add(sec(10))
		a := s.nextTimer()
		for a.at.Before(end) {
			a = s.fire(a)
		}
		s.disconnect(end)
		cur = end.Add(sec(b))
	}
	startGapsAtLeast(t, f.starts)
	if len(f.starts) < 4 {
		t.Fatalf("starts = %v; samples starve under repeated short sessions", rel(f.starts))
	}
	timersBalanced(t, f)
}

// If the scheduled time passed while disconnected, collect immediately on
// reconnect and use that moment as the new base. Without rebasing, the old
// slot (+120) would come only 50 s after the immediate collection (+70).
func TestMetricsLongOutageImmediateAndRebase(t *testing.T) {
	f := newFakeEnv(0)
	ms := &metricsSched{}
	s := startSession(t, f, ms)
	s.fire(s.nextTimer())
	s.disconnect(t0.Add(sec(5)))

	f.set(t0.Add(sec(70)))
	s = startSession(t, f, ms)
	a := s.nextTimer()
	if want := t0.Add(sec(70)); !a.at.Equal(want) {
		t.Fatalf("first collection after a 70s gap at +%v, want immediate (+70s)", a.at.Sub(t0))
	}
	a = s.fire(a)
	if want := t0.Add(sec(130)); !a.at.Equal(want) {
		t.Fatalf("collection after the immediate one at +%v, want +%v (new base + 60)", a.at.Sub(t0), want.Sub(t0))
	}
	s.disconnect(a.at.Add(-time.Second))
	startGapsAtLeast(t, f.starts)
	timersBalanced(t, f)
}

// A send failure ends the session (back to the reconnect loop) and does not
// update the schedule.
func TestMetricsSendErrorEndsSession(t *testing.T) {
	f := newFakeEnv(0)
	f.sendErr = errors.New("write failed")
	ms := &metricsSched{}
	s := startSession(t, f, ms)
	s.fireOnly(s.nextTimer())
	select {
	case err := <-s.done:
		if err == nil || !strings.Contains(err.Error(), "metrics") {
			t.Fatalf("err = %v, want a metrics error", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session does not end after a send failure")
	}
	if ms.set {
		t.Fatal("a failed send set the schedule; the next session would not collect immediately")
	}
	timersBalanced(t, f)
}
